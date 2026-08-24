import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { DetailedPeerCertificate, TLSSocket } from 'node:tls';
import * as ftp from 'basic-ftp';
import { ProviderError, TamperDetectedError } from '../core/errors.js';
import { assertSafeFilename, assertSafeVaultName, isSafeFilename } from '../core/fs-utils.js';
import { hashBuffer, SHA256_BYTES, streamToBuffer } from '../core/hash.js';
import { buildShardHeaderFromBytes, computeShardHeaderSize, SHARD_HEADER_READ_BYTES, sidecarFilename } from '../core/shard-io.js';
import { fmtFor, t, tFor } from '../i18n/index.js';
import type { CliProviderInput, ConfigureEditContext, ProviderConfig, ProviderHelp, ProviderIO, RecoverySecret, RemoteRef, ShardHeader, ShardIdentity, StorageProvider, VerifyShardResult } from '../types/index.js';
import { findStringFlag, readJsonObjectFile } from './flags.js';
import { finishVerifyShard } from './header-verify.js';
import { askIdentityTrust, requestConfigureRestart, withConfigureRestarts } from './identity-trust.js';
import { type ProviderFactory, providerRegistry } from './provider.js';

const CHECKSUM_SIZE = SHA256_BYTES;
const FTP_TIMEOUT_MS = 10_000;
const UPLOAD_CHUNK_SIZE = 64 * 1024;
const MAX_UPLOAD_ATTEMPTS = 3;
/**
 * Delays before each `SIZE` poll after STOR completes. The first poll runs
 * immediately; subsequent polls back off to absorb a metadata-propagation
 * race observed on vsftpd-on-Docker, where `stat()` briefly returns a
 * smaller size than the bytes vsftpd already counted on the data socket.
 */
const SIZE_RETRY_DELAYS_MS: readonly number[] = [0, 100, 250, 500];

/**
 * Wraps a Buffer in a Readable that emits it as fixed-size chunks.
 *
 * `Readable.from(buffer)` pushes the whole buffer in a single chunk. When
 * basic-ftp's `pipeline(source, dataSocket)` then forwards a multi-MB chunk
 * to the TCP data socket, certain server/network configurations (notably
 * Docker-bridged vsftpd on Windows) silently drop bytes - observed as
 * 61 799 B loss on a 263 MB shard. Splitting into 64 KB chunks matches the
 * known-good behavior of `createReadStream`, lets backpressure cooperate,
 * and removes the truncation.
 */
function bufferToChunkedStream(buffer: Buffer, chunkSize = UPLOAD_CHUNK_SIZE): Readable {
  let offset = 0;
  return new Readable({
    read(this: Readable) {
      if (offset >= buffer.length) {
        this.push(null);
        return;
      }
      const end = Math.min(offset + chunkSize, buffer.length);
      this.push(buffer.subarray(offset, end));
      offset = end;
    },
  });
}

/** Colon-hex SHA-256 fingerprint shape: 32 hex byte-pairs joined by ':' (the
 * form Node's `X509Certificate.fingerprint256` / `getPeerCertificate().fingerprint256`
 * and `openssl x509 -fingerprint -sha256` produce). Case-insensitive. */
const CERT_FINGERPRINT_RE = /^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/;

/** True when `value` is a well-formed colon-hex SHA-256 certificate fingerprint. */
function isValidCertFingerprint(value: string): boolean {
  return CERT_FINGERPRINT_RE.test(value.trim());
}

/**
 * Extracts the numeric FTP reply code from a basic-ftp error (FTPError carries
 * `code`, e.g. 550 = file unavailable, 530 = not logged in). Returns null when
 * the error has no numeric code.
 */
function ftpReplyCode(err: unknown): Nullable<number> {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return null;
}

/**
 * StorageProvider backed by an FTP/FTPS server via `basic-ftp`.
 *
 * Directory layout on the remote server:
 *   {basePath}/{vault_name}/{filename}
 *
 * Every public method opens a fresh FTP connection, performs the operation, and
 * closes the connection in a `finally` block. This avoids stale-connection issues
 * and keeps the provider stateless between calls.
 */
export class FtpProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'ftp';

  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  // Mutable: connectForRecovery() collects the password interactively at recovery
  // time (it is stripped from the location map) and assigns it before connecting.
  private password: string;
  private readonly basePath: string;
  private readonly secure: boolean;
  // Pinned FTPS certificate fingerprint (colon-hex SHA-256), or null when no pin
  // is configured. Non-secret - travels in the location map like the SSH host-key
  // pin, so recovery can show the operator which server identity it will trust.
  private readonly certFingerprint: Nullable<string>;
  // TOFU opt-in, consent given up front: trust whatever certificate the server
  // presents on first connect when no pin is set (mirrors SSH --accept-new-host-key).
  private readonly acceptNewCert: boolean;
  private readonly io: ProviderIO;
  private vaultName: Nullable<string> = null;
  // One-shot guard so the plaintext-FTP warning fires once per provider instance
  // (~ once per push/pull) instead of on every per-operation connect.
  private plaintextWarned = false;

  constructor(config: ProviderConfig, io: ProviderIO) {
    // Lazy init - an incomplete config is allowed so CLI can construct a
    // placeholder instance and call configureInteractive/configureFromFlags
    // on it before persisting. Validation happens in validateConfig() and
    // at the point of actual use (withClient / probeConnection).
    this.id = config.id;
    this.io = io;
    const c = config.config;
    this.host = typeof c.host === 'string' ? c.host : '';
    this.port = typeof c.port === 'number' ? c.port : 21;
    this.user = typeof c.user === 'string' ? c.user : '';
    this.password = typeof c.password === 'string' ? c.password : '';
    this.basePath = typeof c.path === 'string' ? c.path : '';
    // Secure by default: only an explicit `secure:false` opts out to plaintext FTP.
    this.secure = c.secure !== false;
    // Trim so a pin copied with trailing whitespace (e.g. from `openssl` output)
    // still matches the presented fingerprint at connect time.
    this.certFingerprint = typeof c.cert_fingerprint === 'string' ? c.cert_fingerprint.trim() : null;
    this.acceptNewCert = c.accept_new_cert === true;
  }

  // --- Private helpers ------------------------------------------------------

  /**
   * Opens a fresh FTP connection, runs `op`, and always closes the client.
   * Wraps network / auth / FTP errors in ProviderError; a ProviderError raised
   * inside `op` and a TamperDetectedError from the certificate-pin check pass
   * through unwrapped.
   */
  private async withClient<T>(op: (client: ftp.Client) => Promise<T>): Promise<T> {
    const client = new ftp.Client(FTP_TIMEOUT_MS);
    try {
      this.io.debug(`FTP connecting to ${this.host}:${this.port}`);
      await this.accessWithCertTrust(client);
      // Belt-and-suspenders binary mode. access()/useDefaultSettings() already
      // issue TYPE I; a bare repeat per session is cheap insurance against any
      // control-channel state drift between auth and STOR.
      await client.send('TYPE I');
      return await op(client);
    } catch (err) {
      // A pin mismatch is a TamperDetectedError (extends BfsError, not
      // ProviderError) and MUST survive to the caller - wrapping it into a generic
      // ProviderError would erase the MITM signal.
      if (err instanceof ProviderError || err instanceof TamperDetectedError) throw err;
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_operation_failed', this.host, String(this.port), err instanceof Error ? err.message : String(err)));
    } finally {
      client.close();
    }
  }

  /**
   * Connects `client` to the server, applying the FTPS certificate-trust
   * decision BEFORE login when TLS is enabled.
   *
   * For `secure:true` the connection is driven step-by-step
   * (connect -> useTLS -> verify certificate -> login) rather than via the bundled
   * `access()`, because `access()` sends the password (PASS) as part of login
   * immediately after the TLS upgrade. The pin/TOFU check therefore has to happen
   * between `useTLS` and `login`, so a mismatching or untrusted certificate aborts
   * before any credential crosses the wire. `rejectUnauthorized:false` lets a
   * self-signed certificate complete the handshake; trust is then established by
   * the pinned fingerprint (or TOFU), not the CA chain.
   *
   * @throws TamperDetectedError when a configured pin does not match the presented
   *   certificate; ProviderError when trust cannot be established (no pin, no TOFU
   *   opt-in, non-interactive) or the operator declines.
   */
  private async accessWithCertTrust(client: ftp.Client, quiet = false): Promise<void> {
    if (!this.secure) {
      await client.access({ host: this.host, port: this.port, user: this.user, password: this.password, secure: false });
      if (!quiet) this.warnInsecureOnce();
      return;
    }
    await client.connect(this.host, this.port);
    await client.useTLS({ rejectUnauthorized: false, host: this.host });
    const cert = this.readPeerCertificate(client);
    await this.decideCertTrust(cert);
    await client.login(this.user, this.password);
    await client.useDefaultSettings();
  }

  /**
   * Reads the peer certificate off the client's (now TLS-upgraded) control
   * socket. Uses a structural check for `getPeerCertificate` rather than
   * `instanceof tls.TLSSocket` so the same path works over a real TLS socket and
   * an in-memory test double.
   *
   * @throws ProviderError when the socket did not upgrade to TLS or presents no
   *   certificate.
   */
  private readPeerCertificate(client: ftp.Client): DetailedPeerCertificate {
    const socket = client.ftp.socket as TLSSocket;
    if (typeof socket.getPeerCertificate !== 'function') {
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_tls_not_established', this.host));
    }
    const cert = socket.getPeerCertificate(true);
    if (cert === null || typeof cert.fingerprint256 !== 'string' || cert.fingerprint256.length === 0) {
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_tls_not_established', this.host));
    }
    return cert;
  }

  /**
   * Decides whether to trust the presented FTPS certificate, mirroring the SSH
   * host-key trust ladder:
   *   - pin set -> trust only when the fingerprint matches; mismatch is tamper.
   *   - no pin + `accept_new_cert` -> trust on first use (consent given up front,
   *     so it settles the question in every mode).
   *   - no pin + interactive -> show the operator the fingerprint and kind, confirm.
   *   - no pin + non-interactive -> fail closed (cannot establish trust).
   *
   * @throws TamperDetectedError on a pin mismatch; ProviderError when trust cannot
   *   be established or the operator declines.
   */
  private async decideCertTrust(cert: DetailedPeerCertificate): Promise<void> {
    const presented = cert.fingerprint256;
    if (this.certFingerprint !== null) {
      if (presented.toUpperCase() === this.certFingerprint.toUpperCase()) return;
      throw new TamperDetectedError(fmtFor(this.io.lang, 'ftp_cert_pin_mismatch', `${this.host}:${this.port}`, this.certFingerprint, presented));
    }
    if (this.acceptNewCert) return;
    if (this.io.interactive === false) {
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_cert_untrusted', `${this.host}:${this.port}`, presented));
    }
    const approved = await this.io.confirm(fmtFor(this.io.lang, 'ftp_cert_confirm', `${this.host}:${this.port}`, this.certKindLabel(cert), presented));
    if (!approved) {
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_cert_declined', `${this.host}:${this.port}`));
    }
  }

  /** True when the certificate is self-signed (its issuer certificate is itself). */
  private isSelfSigned(cert: DetailedPeerCertificate): boolean {
    return cert.raw !== undefined && cert.issuerCertificate !== undefined && cert.issuerCertificate !== null && Buffer.isBuffer(cert.raw) && Buffer.isBuffer(cert.issuerCertificate.raw) && cert.raw.equals(cert.issuerCertificate.raw);
  }

  /**
   * Human-readable certificate kind shown at the trust prompt, so the operator
   * distinguishes an expected self-signed HomeLab certificate from a CA-signed
   * one (trusted or not). Self-signed is decided structurally; CA trust reflects
   * the standard chain validation Node computes even under `rejectUnauthorized:false`.
   */
  private certKindLabel(cert: DetailedPeerCertificate): string {
    if (this.isSelfSigned(cert)) return tFor(this.io.lang, 'ftp_cert_kind_self_signed');
    return tFor(this.io.lang, 'ftp_cert_kind_ca');
  }

  /**
   * Opens a throwaway TLS connection and reads the certificate the server
   * presents. No login is attempted - the certificate arrives during the
   * handshake, before any credential is needed. Reading is kept separate from
   * the operator's decision so a caller can tell an unreachable server (retry
   * elsewhere) from a refused certificate (a decision, final).
   *
   * @param host - FTPS host to contact
   * @param port - control port
   * @returns the presented fingerprint and whether the certificate is self-signed
   * @throws ProviderError when TLS does not establish or no certificate is presented
   */
  private async readServerCert(host: string, port: number): Promise<{ fingerprint: string; selfSigned: boolean }> {
    const client = new ftp.Client(FTP_TIMEOUT_MS);
    try {
      await client.connect(host, port);
      await client.useTLS({ rejectUnauthorized: false, host });
      const cert = this.readPeerCertificate(client);
      return { fingerprint: cert.fingerprint256, selfSigned: this.isSelfSigned(cert) };
    } finally {
      client.close();
    }
  }

  /**
   * Shows the operator the presented certificate (fingerprint + kind) and
   * returns it once they accept.
   *
   * @param io        - ProviderIO for the trust prompt
   * @param host      - FTPS host the certificate came from
   * @param port      - control port
   * @param presented - the fingerprint/kind read off the wire
   * @returns the accepted certificate identity, to persist as the pin
   * @throws ProviderError when the operator declines
   */
  private async confirmCert(io: ProviderIO, host: string, port: number, presented: { fingerprint: string; selfSigned: boolean }): Promise<{ fingerprint: string; selfSigned: boolean }> {
    const target = `${host}:${port}`;
    const kind = presented.selfSigned ? tFor(io.lang, 'ftp_cert_kind_self_signed') : tFor(io.lang, 'ftp_cert_kind_ca');
    const choice = await askIdentityTrust(io, fmtFor(io.lang, 'ftp_cert_trust_menu', target, kind, presented.fingerprint), fmtFor(io.lang, 'ftp_cert_confirm', target, kind, presented.fingerprint));
    if (choice === 'back') requestConfigureRestart(`certificate decision for ${target}`);
    if (choice === 'cancel') {
      throw new ProviderError(fmtFor(io.lang, 'ftp_cert_declined', target));
    }
    return presented;
  }

  /**
   * Trust-on-first-use capture: reads the server's certificate and returns the
   * pin to persist once the operator accepts it.
   *
   * @throws ProviderError when the operator declines or TLS does not establish.
   */
  private async captureCert(io: ProviderIO, host: string, port: number): Promise<{ fingerprint: string; selfSigned: boolean }> {
    return this.confirmCert(io, host, port, await this.readServerCert(host, port));
  }

  /**
   * Certificate menu shown when the server is unreachable during an edit: paste
   * a fingerprint read off a second channel, go back to the connection prompts,
   * save without a pin, or cancel. Returns the fingerprint to pin - an empty
   * string means "save without a pin".
   *
   * @param io   - ProviderIO for the menu and the paste prompt
   * @param host - FTPS host the edit points at
   * @param port - control port
   * @returns the fingerprint to pin, or '' to save unpinned
   * @throws ProviderError when the operator cancels; ConfigureRestartRequested
   *   when they ask for the connection prompts again
   */
  private async offlineCertMenu(io: ProviderIO, host: string, port: number): Promise<string> {
    const optPaste = tFor(io.lang, 'ftp_edit_offline_paste');
    const optBack = tFor(io.lang, 'trust_choice_back');
    const optNoPin = tFor(io.lang, 'ftp_edit_offline_no_pin');
    const optExit = tFor(io.lang, 'ftp_edit_offline_exit');
    // Pasting stays first: a typo in the address lands here more often than at
    // the certificate decision, but the operator who does have the fingerprint
    // to hand is the common case, and existing scenarios answer by position.
    const choice = await io.choose(fmtFor(io.lang, 'ftp_edit_offline_menu', `${host}:${port}`), [optPaste, optBack, optNoPin, optExit]);
    switch (choice) {
      case optPaste:
        return this.promptCertFingerprint(io);
      case optBack:
        requestConfigureRestart(`unreachable target ${host}:${port}`);
        break;
      case optNoPin:
        io.warn(tFor(io.lang, 'ftp_edit_no_pin_warn'));
        return '';
      default:
        // optExit or any unexpected selection -> cancel the edit (fail-closed).
        throw new ProviderError(tFor(io.lang, 'ftp_edit_cancelled'));
    }
  }

  /**
   * Prompts for an operator-pasted certificate fingerprint, re-prompting on a
   * malformed value. Empty input (Enter, or a closed stream) abandons the paste
   * and cancels the edit, so an EOF stdin can never spin the loop forever.
   *
   * @param io - ProviderIO for the prompt
   * @returns a well-formed colon-hex SHA-256 fingerprint
   * @throws ProviderError on empty input
   */
  private async promptCertFingerprint(io: ProviderIO): Promise<string> {
    for (;;) {
      const entered = (await io.ask(tFor(io.lang, 'ftp_edit_paste_prompt'))).trim();
      if (entered.length === 0) throw new ProviderError(tFor(io.lang, 'ftp_edit_cancelled'));
      if (isValidCertFingerprint(entered)) return entered;
      // Not the flag-shaped message: the operator is standing at a prompt, not
      // passing --cert-fingerprint, and needs to know the question comes back.
      io.warn(tFor(io.lang, 'ftp_edit_fingerprint_invalid'));
    }
  }

  /**
   * Emits the plaintext-FTP warning once per provider instance. A plain
   * (non-FTPS) connection sends the password and shard bytes in the clear, so
   * the user is warned - but only on the first connect, to avoid one line per
   * shard during a push.
   */
  private warnInsecureOnce(): void {
    if (this.plaintextWarned) return;
    this.plaintextWarned = true;
    this.io.warn(fmtFor(this.io.lang, 'ftp_insecure_warning', `${this.host}:${this.port}`));
  }

  /**
   * Returns the remote vault directory path: {basePath}/{vaultName}.
   * @throws ProviderError if setVaultName() has not been called yet, or the
   *   assembled path carries a line break / NUL (FTP control-channel injection).
   */
  private vaultPath(): string {
    if (this.vaultName === null) {
      throw new ProviderError('setVaultName() must be called before any file operation');
    }
    // Path-traversal floor (BFS-core invariant) runs before the FTP-specific
    // control-channel guard below: separators / '..' would let a crafted name
    // escape the base directory on the remote just as on a local disk.
    assertSafeVaultName(this.vaultName);
    const full = `${this.basePath}/${this.vaultName}`;
    // A CR/LF or NUL in a path sent over the FTP control channel could let a
    // crafted base path or backup name inject extra FTP commands. Reject before
    // the string reaches CWD/STOR/LIST.
    if (/[\r\n\0]/.test(full)) {
      throw new ProviderError(tFor(this.io.lang, 'ftp_control_chars'));
    }
    return full;
  }

  /**
   * Builds {vaultPath}/{filename}, rejecting a filename that is not a safe path
   * segment (traversal / separator / control char) before it is joined - a
   * crafted ref.path or a hostile server's LIST entry cannot escape the vault.
   */
  private remoteFile(filename: string): string {
    assertSafeFilename(filename);
    return `${this.vaultPath()}/${filename}`;
  }

  /**
   * Polls `SIZE` on a freshly-uploaded path, returning the first observed
   * value that matches `expectedSize`. Returns the last observed size if
   * every attempt mismatches.
   *
   * vsftpd on writeback-cached file systems can briefly report a stale size
   * for a newly-created file between `226 Transfer complete` and the next
   * `SIZE` round-trip. The short retry closes that gap without weakening
   * detection of true persistent truncation, which would keep returning the
   * same wrong value across all attempts.
   */
  private async verifyRemoteSize(client: ftp.Client, remotePath: string, expectedSize: number): Promise<number> {
    let lastObserved = -1;
    for (const delay of SIZE_RETRY_DELAYS_MS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      lastObserved = await client.size(remotePath);
      if (lastObserved === expectedSize) return lastObserved;
    }
    return lastObserved;
  }

  /**
   * Uploads `buffer` to `remotePath`, retrying up to MAX_UPLOAD_ATTEMPTS times
   * if the post-STOR `SIZE` does not match. Some vsftpd/Docker deployments
   * randomly truncate uploads (verified independently with Windows Explorer -
   * not BFS-specific). A fresh STOR on the next attempt almost always
   * delivers the full payload.
   *
   * Persistent mismatches (e.g. ASCII mode silently rewriting bytes) keep
   * returning the same wrong size across all attempts and surface as
   * `ProviderError` after the last try.
   */
  private async uploadWithRetry(client: ftp.Client, remotePath: string, buffer: Buffer, label: string): Promise<void> {
    let lastSize = -1;
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
      await client.uploadFrom(bufferToChunkedStream(buffer), remotePath);
      lastSize = await this.verifyRemoteSize(client, remotePath, buffer.length);
      if (lastSize === buffer.length) return;
      if (attempt < MAX_UPLOAD_ATTEMPTS) {
        this.io.warn(fmtFor(this.io.lang, 'ftp_size_mismatch_attempt', label, String(attempt), String(MAX_UPLOAD_ATTEMPTS), String(buffer.length), String(lastSize)));
        await this.bestEffortRemove(client, remotePath);
      }
    }
    throw new ProviderError(fmtFor(this.io.lang, 'ftp_size_mismatch_final', label, String(MAX_UPLOAD_ATTEMPTS), String(buffer.length), String(lastSize), String(lastSize - buffer.length)));
  }

  /**
   * Downloads a remote file into a single Buffer. Buffering (rather than
   * returning a lazy stream) is necessary because withClient closes the
   * connection in `finally`, so a lazy stream would fail after the client
   * disconnects.
   */
  private async downloadToBuffer(client: ftp.Client, remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk: Buffer | Uint8Array, _encoding: string, cb: () => void) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        cb();
      },
    });
    await client.downloadTo(writable, remotePath);
    return Buffer.concat(chunks);
  }

  // --- StorageProvider interface --------------------------------------------

  /**
   * Verifies FTP connectivity by connecting and listing the base path.
   *
   * @throws ProviderError if the connection or directory listing fails.
   */
  async authenticate(): Promise<void> {
    await this.withClient(async (client) => {
      await client.list(this.basePath);
    });
  }

  /**
   * Sets the vault sub-directory name. Must be called before any file operations.
   *
   * @param name - Vault name (used as subdirectory under basePath)
   */
  setVaultName(name: string): void {
    this.vaultName = name;
  }

  /**
   * Recovery hook: shows the operator the FTP target (host[:port] and path) and
   * lets them decline BEFORE any credential is sent. This is the defense against
   * a recovery whose location map was redirected to a hostile host - the
   * operator sees exactly where the password would go and can refuse. Once the
   * host is approved, a pooled secret (collected for a sibling) is tried first,
   * then the password is prompted with retry until one authenticates.
   *
   * @param io      - ProviderIO for the host confirmation and password prompt
   * @param pool    - secrets already collected this recovery, tried before prompting
   * @param options - `trustLocation` skips the host confirmation (unattended
   *                  recovery) and only logs the target
   * @returns the password that authenticated (added to the recovery pool)
   * @throws ProviderError when the operator declines (host or blank password),
   *         or when there is no operator to confirm the host
   */
  async connectForRecovery(io: ProviderIO, pool: readonly RecoverySecret[], options?: { trustLocation?: boolean }): Promise<Nullable<string>> {
    const target = this.port === 21 ? this.host : `${this.host}:${this.port}`;
    const remotePath = this.basePath.length > 0 ? this.basePath : '/';
    if (options?.trustLocation === true) {
      // Operator pre-approved the recovered locations (unattended recovery via
      // `bfs recovery --trust-locations`) - surface the target for the log but
      // do not block on a confirmation.
      io.info(fmtFor(this.io.lang, 'ftp_recovery_target', target, remotePath));
    } else if (io.interactive === false) {
      // The confirmation would answer itself with "no", and bootstrap turns any
      // throw from here into a silent skip of this storage - so the reason has
      // to be spoken before the throw, and through warn(): the recovery spinner
      // routes info() into spinner.text, which a piped run never emits at all.
      io.warn(fmtFor(this.io.lang, 'ftp_recovery_no_operator', target));
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_recovery_no_operator', target));
    } else {
      const approved = await io.confirm(fmtFor(this.io.lang, 'ftp_recovery_confirm_host', target, remotePath));
      if (!approved) {
        throw new ProviderError(fmtFor(this.io.lang, 'ftp_recovery_declined', target));
      }
    }
    // Host approved - reuse a pooled secret if one authenticates here (newest
    // first), otherwise prompt with retry. Unbounded retry mirrors the legacy
    // recovery path: at this critical moment the operator keeps trying until the
    // password works or they give up with a blank entry.
    for (let i = pool.length - 1; i >= 0; i--) {
      this.password = pool[i].value;
      try {
        await this.authenticate();
        return this.password;
      } catch {
        // pooled secret did not authenticate here - fall through to prompting
      }
    }
    for (;;) {
      const secret = await io.askSecret(fmtFor(this.io.lang, 'ftp_recovery_password', target));
      if (secret.length === 0) {
        throw new ProviderError(fmtFor(this.io.lang, 'ftp_recovery_declined', target));
      }
      this.password = secret;
      try {
        await this.authenticate();
        return secret;
      } catch {
        // wrong password - re-prompt
      }
    }
  }

  /**
   * Uploads a shard to {basePath}/{vaultName}/{shardFilename}.
   * Buffers the stream to compute the SHA-256 hash before uploading.
   *
   * @param shardFilename - Target filename, e.g. "shard_0.bfs.1"
   * @param data          - Readable stream of the full shard
   * @param _size         - Total byte size (unused - FTP does not need Content-Length)
   * @returns RemoteRef with provider_id, filename, and SHA-256 hash
   * @throws ProviderError on upload failure
   */
  async upload(shardFilename: string, data: Readable, _size: number): Promise<RemoteRef> {
    const buffer = await streamToBuffer(data);
    const hash = hashBuffer(buffer);
    const remotePath = `${this.vaultPath()}/${shardFilename}`;

    await this.withClient(async (client) => {
      await client.ensureDir(this.vaultPath());
      // STOR + post-upload SIZE check, with bounded retry. Some vsftpd/Docker
      // deployments randomly truncate the data connection (reproduced with
      // Windows Explorer too - not BFS-specific); a fresh STOR almost always
      // delivers the full payload. Persistent mismatches (ASCII mode etc.)
      // keep failing and surface as ProviderError after the last attempt.
      // Full byte-for-byte round-trip verification stays in probeConnection().
      await this.uploadWithRetry(client, remotePath, buffer, shardFilename);
      // A fresh shard carries a fresh in-shard header, so a stale sidecar for
      // this filename (from a prior relocate) must go - else it would shadow the
      // new header on the sidecar-aware read-path.
      await this.bestEffortRemove(client, `${this.vaultPath()}/${sidecarFilename(shardFilename)}`);
    });

    return { provider_id: this.id, path: shardFilename, hash };
  }

  /**
   * Downloads a shard as a Readable stream.
   * The entire file is buffered in memory because the FTP connection closes
   * after withClient returns.
   *
   * @param ref - RemoteRef returned by upload() or list()
   * @returns Readable stream of the full shard binary
   * @throws ProviderError if the download fails
   */
  async download(ref: RemoteRef): Promise<Readable> {
    const remotePath = this.remoteFile(ref.path);
    const buffer = await this.withClient(async (client) => {
      return this.downloadToBuffer(client, remotePath);
    });
    return Readable.from(buffer);
  }

  /**
   * Deletes a shard file (and its header sidecar) identified by ref. An
   * already-absent shard is a no-op, not a failure - delete is idempotent
   * (parity with LocalFS/SSH), so a resumed prune raises no false orphan warning.
   *
   * @param ref - RemoteRef of the shard to delete
   * @throws ProviderError if the file cannot be deleted
   */
  async delete(ref: RemoteRef): Promise<void> {
    const remotePath = this.remoteFile(ref.path);
    await this.withClient(async (client) => {
      await this.idempotentRemove(client, remotePath);
      // Remove the header sidecar too so pruning leaves no orphan behind.
      await this.bestEffortRemove(client, `${this.vaultPath()}/${sidecarFilename(ref.path)}`);
    });
  }

  /**
   * Renames a shard file on the FTP server.
   *
   * @param ref         - RemoteRef of the existing file
   * @param newFilename - New bare filename (not full path)
   * @returns New RemoteRef pointing to the renamed file (no hash)
   * @throws ProviderError on failure
   */
  async rename(ref: RemoteRef, newFilename: string): Promise<RemoteRef> {
    const oldPath = this.remoteFile(ref.path);
    const newPath = this.remoteFile(newFilename);
    await this.withClient(async (client) => {
      await client.rename(oldPath, newPath);
    });
    return { provider_id: this.id, path: newFilename };
  }

  /**
   * Replaces the binary header of an existing shard, keeping the RS payload
   * unchanged and recomputing the trailing SHA-256 checksum.
   *
   * FTP does not support partial writes, so the shard is downloaded, modified
   * in memory, and re-uploaded (STOR overwrites the existing file).
   *
   * @param ref        - RemoteRef of the shard to update
   * @param headerData - New serialized header (magic ... end of location map)
   * @returns Updated RemoteRef (same path, no hash)
   * @throws ProviderError on failure or if the shard is too short
   */
  async updateShardHeader(ref: RemoteRef, headerData: Buffer): Promise<RemoteRef> {
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (client) => {
      const existing = await this.downloadToBuffer(client, remotePath);

      const oldHeaderSize = computeShardHeaderSize(existing);
      if (existing.length < oldHeaderSize + CHECKSUM_SIZE) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_short_shard', ref.path));
      }

      const payload = existing.subarray(oldHeaderSize, existing.length - CHECKSUM_SIZE);
      const newBody = Buffer.concat([headerData, payload]);
      const newChecksum = Buffer.from(hashBuffer(newBody), 'hex');
      const newShard = Buffer.concat([newBody, newChecksum]);

      // Same retry strategy as upload() - sporadic vsftpd truncation handled
      // by re-running STOR up to MAX_UPLOAD_ATTEMPTS times.
      await this.uploadWithRetry(client, remotePath, newShard, ref.path);
      return { provider_id: this.id, path: ref.path };
    });
  }

  /**
   * Lists shard files in the vault directory, optionally filtered by prefix.
   *
   * @param prefix - Optional filename prefix filter (e.g. "shard_0")
   * @returns Array of RemoteRef (hash not populated); an unreadable or absent
   *          vault directory yields an empty array
   * @throws ProviderError when the connection itself fails
   */
  async list(prefix?: string): Promise<RemoteRef[]> {
    return this.withClient(async (client) => {
      let entries: ftp.FileInfo[];
      try {
        entries = await client.list(this.vaultPath());
      } catch {
        return [];
      }

      // Drop directories and any name that is not a safe segment - a hostile
      // server could return a traversal filename from LIST (L2).
      const files = entries.filter((e) => !e.isDirectory && isSafeFilename(e.name));
      const filtered = prefix ? files.filter((e) => e.name.startsWith(prefix)) : files;
      return filtered.map((e) => ({ provider_id: this.id, path: e.name }));
    });
  }

  /**
   * Returns the size of a shard via the `SIZE` FTP command - no content
   * transfer over the data channel.
   *
   * @param ref - RemoteRef of the shard
   * @returns   Size in bytes
   * @throws ProviderError if the file is missing or `SIZE` fails
   */
  async getSize(ref: RemoteRef): Promise<number> {
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (client) => {
      try {
        return await client.size(remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_stat_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * Reads at most `maxBytes` bytes from the start of the shard - enough to read
   * just the header (~16 KB) without buffering the full payload.
   *
   * Strategy:
   *   - If `SIZE` <= maxBytes: download the whole file (it's small).
   *   - Otherwise: pipe into a Writable that aborts the transfer once it has
   *     collected `maxBytes`. basic-ftp surfaces the abort as an error which
   *     we swallow because we already hold the bytes we need; any
   *     pre-abort transport error is re-thrown.
   *
   * @param ref      - RemoteRef of the shard
   * @param maxBytes - Maximum byte count to return (must be > 0)
   * @returns          Buffer of `min(file_size, maxBytes)` bytes
   * @throws ProviderError on transport failure or missing shard
   */
  async downloadHeader(ref: RemoteRef, maxBytes: number): Promise<Buffer> {
    if (maxBytes <= 0) {
      throw new ProviderError(fmtFor(this.io.lang, 'provider_download_header_invalid_max_bytes', String(maxBytes)));
    }
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (client) => {
      let totalSize: number;
      try {
        totalSize = await client.size(remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_stat_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }

      // Shard fits entirely within the requested window - pull it once.
      if (totalSize <= maxBytes) {
        return this.downloadToBuffer(client, remotePath);
      }
      try {
        return await this.collectBounded(client, remotePath, maxBytes);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_header_read_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * Streams a remote file into a buffer but aborts the transfer once `maxBytes`
   * have been collected, so a large shard is not pulled in full. Rethrows the
   * raw transport error (unwrapped) when the failure is not the deliberate
   * abort, letting the caller classify FTP reply codes.
   *
   * @param client     - Connected FTP client
   * @param remotePath - Absolute remote path
   * @param maxBytes   - Maximum byte count to collect before aborting
   * @returns Buffer of at most `maxBytes` bytes
   */
  private async collectBounded(client: ftp.Client, remotePath: string, maxBytes: number): Promise<Buffer> {
    // `aborted` is set immediately before destroying the Writable so the catch
    // below can distinguish a deliberate abort from a real transport error.
    const chunks: Buffer[] = [];
    let collected = 0;
    let aborted = false;
    const collector = new Writable({
      write(chunk: Buffer | Uint8Array, _enc: string, cb: () => void) {
        if (aborted) {
          cb();
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxBytes - collected;
        if (buf.length >= remaining) {
          chunks.push(buf.subarray(0, remaining));
          collected = maxBytes;
          aborted = true;
          this.destroy();
          cb();
          return;
        }
        chunks.push(buf);
        collected += buf.length;
        cb();
      },
    });

    try {
      await client.downloadTo(collector, remotePath);
    } catch (err) {
      if (!aborted) throw err;
      // Deliberate abort - basic-ftp surfaces the destroyed writable as an
      // error. We already hold the bytes we need.
    }
    return Buffer.concat(chunks);
  }

  /**
   * Lists vault sub-directories under basePath.
   *
   * @returns Array of vault names (directory names)
   * @throws ProviderError if basePath cannot be read
   */
  async listVaults(): Promise<string[]> {
    return this.withClient(async (client) => {
      const entries = await client.list(this.basePath);
      return entries.filter((e) => e.isDirectory).map((e) => e.name);
    });
  }

  /**
   * Checks whether the FTP server is reachable by connecting and disconnecting.
   * Never throws - returns false on any error.
   *
   * @returns true if the server is reachable, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.withClient(async () => true);
    } catch {
      return false;
    }
  }

  // --- Header storage strategy + verification -------------------------------

  /** FTP keeps a relocated shard's header in an `hdr_` sidecar next to it. */
  usesSidecar(): boolean {
    return true;
  }

  /**
   * Uploads the header sidecar (BFSH bytes) to `hdr_i.bfs.V` next to the shard,
   * with the same STOR + post-upload SIZE verification as a shard upload. The
   * payload is KB-sized, so this replaces a full shard re-upload on relocate.
   *
   * @param ref          - RemoteRef of the shard the sidecar belongs to
   * @param sidecarBytes - Sidecar payload in BFSH format (see buildSidecarBytes)
   * @throws ProviderError on upload failure
   */
  async uploadHeaderSidecar(ref: RemoteRef, sidecarBytes: Buffer): Promise<void> {
    const name = sidecarFilename(ref.path);
    const remotePath = `${this.vaultPath()}/${name}`;
    await this.withClient(async (client) => {
      await client.ensureDir(this.vaultPath());
      await this.uploadWithRetry(client, remotePath, sidecarBytes, name);
    });
  }

  /**
   * Downloads the header sidecar `hdr_i.bfs.V` next to the shard, or null when
   * none exists (SIZE replies 550). A sidecar is header-only, so it is pulled in
   * full - bounded by its own size, not the payload.
   *
   * @param ref       - RemoteRef of the shard
   * @param _maxBytes - Byte cap (a sidecar is inherently small; the whole file is read)
   * @returns Sidecar bytes (BFSH format) or null when absent
   * @throws ProviderError on a transport failure other than "not found"
   */
  async downloadHeaderSidecar(ref: RemoteRef, _maxBytes: number): Promise<Nullable<Buffer>> {
    assertSafeFilename(ref.path);
    const remotePath = `${this.vaultPath()}/${sidecarFilename(ref.path)}`;
    return this.withClient(async (client) => {
      try {
        await client.size(remotePath);
      } catch (err) {
        if (ftpReplyCode(err) === 550) return null;
        throw new ProviderError(fmtFor(this.io.lang, 'provider_header_read_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
      return this.downloadToBuffer(client, remotePath);
    });
  }

  /**
   * Opens a dedicated FTP connection and returns the shard's header window (at
   * most maxBytes). Unlike withClient, it does NOT wrap errors, so the caller
   * can read the raw FTP reply code (530 auth, 550 missing) for classification.
   * Always closes the connection.
   *
   * @param remotePath - Absolute remote path of the shard
   * @param maxBytes   - Maximum byte count to read from the header
   * @returns Buffer of at most `maxBytes` bytes
   * @throws the raw transport / FTPError (unwrapped)
   */
  private async readHeaderWindowDirect(remotePath: string, maxBytes: number): Promise<Buffer> {
    const client = new ftp.Client(FTP_TIMEOUT_MS);
    try {
      // Quiet: verify is the silent header-inspection path (no plaintext warning).
      // A certificate pin mismatch still throws TamperDetectedError here, which
      // verifyShard re-throws rather than folding into an `unverifiable` result.
      await this.accessWithCertTrust(client, true);
      await client.send('TYPE I');
      const totalSize = await client.size(remotePath);
      return totalSize <= maxBytes ? await this.downloadToBuffer(client, remotePath) : await this.collectBounded(client, remotePath, maxBytes);
    } finally {
      client.close();
    }
  }

  /**
   * Verifies the shard identity by reading only its header window and comparing
   * the plaintext vault_id / shard_index / version. Reads over a dedicated
   * connection so the raw FTP reply codes survive: 530 -> auth_failed,
   * 550 -> not_found.
   *
   * @param ref      - RemoteRef of the shard
   * @param expected - Identity the shard is expected to carry
   * @returns { ok: true } or a classified failure (auth_failed / not_found /
   *          corrupted / mismatch / unverifiable). A transport failure with no
   *          recognized reply code (host down, ECONNREFUSED, TLS) is reported
   *          as unverifiable rather than thrown, mirroring LocalFsProvider.
   * @throws TamperDetectedError when the presented certificate does not match
   *         the configured pin - a MITM signal is never folded into a verdict
   */
  async verifyShard(ref: RemoteRef, expected: ShardIdentity): Promise<VerifyShardResult> {
    const lang = this.io.lang;
    const remotePath = this.remoteFile(ref.path);

    let headerBytes: Buffer;
    try {
      headerBytes = await this.readHeaderWindowDirect(remotePath, SHARD_HEADER_READ_BYTES);
    } catch (err) {
      // A certificate pin mismatch is a deliberate MITM signal, not an
      // "unverifiable" transport hiccup - surface it so verify/recovery refuses
      // the tampered host instead of silently degrading.
      if (err instanceof TamperDetectedError) throw err;
      switch (ftpReplyCode(err)) {
        case 530:
          return { ok: false, reason: 'auth_failed', detail: fmtFor(lang, 'verify_shard_auth_failed', this.id, ref.path) };
        case 550:
          return { ok: false, reason: 'not_found', detail: fmtFor(lang, 'verify_shard_not_found', ref.path) };
        default:
          return { ok: false, reason: 'unverifiable', detail: fmtFor(lang, 'verify_shard_unverifiable', this.id, ref.path) };
      }
    }

    // The header window has no payload or trailing checksum, so parse it
    // synchronously - no payload stream to build, verify, or discard.
    let header: ShardHeader;
    try {
      header = buildShardHeaderFromBytes(headerBytes);
    } catch (err) {
      return { ok: false, reason: 'corrupted', detail: fmtFor(lang, 'verify_shard_corrupted', ref.path, err instanceof Error ? err.message : String(err)) };
    }

    return finishVerifyShard(header, expected, lang);
  }

  // --- Configuration lifecycle ----------------------------------------------

  /**
   * Interactively prompts the user for all FTP fields via ProviderIO and, for a
   * secure connection, reads the server certificate and pins the fingerprint the
   * operator accepts. Does not mutate this instance - the caller persists the
   * result into VaultConfig.
   *
   * @throws ProviderError when the operator declines the certificate, when TLS
   *         does not establish, or when the operator uses up the restarts
   * @throws whatever the supplied ProviderIO throws (e.g. on cancellation)
   */
  async configureInteractive(io: ProviderIO): Promise<Record<string, unknown>> {
    return withConfigureRestarts(
      io,
      () => this.collectAddConfig(io),
      () => new ProviderError(tFor(io.lang, 'configure_restarts_exhausted')),
    );
  }

  /**
   * One pass over the add-time settings. Re-run from scratch whenever the
   * operator goes back at the certificate decision, so nothing read during an
   * abandoned pass survives into the config.
   *
   * @param io - ProviderIO carrying the prompts
   * @returns the connection-config to persist
   */
  private async collectAddConfig(io: ProviderIO): Promise<Record<string, unknown>> {
    const fields = await this.collectFtpFields(io);
    const config: Record<string, unknown> = { ...fields };

    // Trust-on-first-use: when TLS is enabled, connect once to read the server's
    // certificate, show the operator its fingerprint and kind, and persist the pin
    // once they accept - so later connections verify the identity, not the CA chain.
    if (fields.secure) {
      const { fingerprint, selfSigned } = await this.captureCert(io, fields.host, fields.port);
      config.cert_fingerprint = fingerprint;
      config.cert_self_signed = selfSigned;
    }

    return config;
  }

  /**
   * Prompts for the FTP connection fields via ProviderIO - everything except the
   * certificate-trust step. Shared by the add flow (`configureInteractive`) and
   * the edit flow (`configureInteractiveForEdit`).
   *
   * @param io - ProviderIO carrying the prompts
   * @returns the collected fields, spread verbatim into the final config
   */
  private async collectFtpFields(io: ProviderIO): Promise<{ host: string; port: number; user: string; password: string; path: string; secure: boolean }> {
    const host = (await io.ask(t('ftp_host_prompt'))).trim();
    const portStr = (await io.ask(t('ftp_port_prompt'))).trim();
    const user = (await io.ask(t('ftp_user_prompt'))).trim();
    const password = await io.askSecret(t('ftp_password_prompt'));
    const remotePath = (await io.ask(t('ftp_path_prompt'))).trim();
    const secure = await io.confirm(t('ftp_secure_prompt'));
    return { host, port: portStr.length === 0 ? 21 : Number(portStr), user, password, path: remotePath, secure };
  }

  /**
   * Interactive `bfs provider edit` flow. Collects the fields, then resolves the
   * certificate pin without ever letting the server dictate it:
   *   - host AND port unchanged and already pinned -> reuse the pin without
   *     contacting the medium, so a credential or path edit stays fully local and
   *     a server that answers at that address cannot replace the trusted identity;
   *   - otherwise the target identity is genuinely new, so read the certificate
   *     for a live confirmation. A refusal aborts; an unreachable server drops to
   *     an offline menu (paste a fingerprint / save unpinned / cancel) so the edit
   *     still completes.
   *
   * @param io  - ProviderIO for prompts and diagnostics
   * @param ctx - carries the existing connection-config (old host/port/pin)
   * @returns the connection-config to persist
   * @throws ProviderError when the operator declines the certificate or cancels
   */
  async configureInteractiveForEdit(io: ProviderIO, ctx: ConfigureEditContext): Promise<Record<string, unknown>> {
    return withConfigureRestarts(
      io,
      () => this.collectEditConfig(io, ctx),
      () => new ProviderError(tFor(io.lang, 'configure_restarts_exhausted')),
    );
  }

  /**
   * One pass over the edit-time settings, including whichever identity decision
   * the target calls for. Re-run from scratch on every restart, so a certificate
   * read during a pass the operator walked away from cannot end up trusted for
   * the address they finally save.
   *
   * @param io  - ProviderIO for prompts and diagnostics
   * @param ctx - carries the existing connection-config (old host/port/pin)
   * @returns the connection-config to persist
   * @throws ProviderError when the operator cancels; ConfigureRestartRequested
   *   when they ask for the prompts again
   */
  private async collectEditConfig(io: ProviderIO, ctx: ConfigureEditContext): Promise<Record<string, unknown>> {
    const fields = await this.collectFtpFields(io);
    const config: Record<string, unknown> = { ...fields };
    const existing = ctx.existingConfig;
    const oldPin = typeof existing.cert_fingerprint === 'string' ? existing.cert_fingerprint : '';

    // No TLS, no certificate: carrying a pin here would fail validateConfig and
    // turn a deliberate downgrade into a config that cannot be saved at all. The
    // loss is permanent and invisible afterwards, so it is said out loud - but
    // only when there was something to lose.
    if (!fields.secure) {
      if (oldPin.length > 0) io.warn(fmtFor(io.lang, 'ftp_edit_pin_dropped', `${fields.host}:${fields.port}`, oldPin));
      return config;
    }

    const oldHost = typeof existing.host === 'string' ? existing.host : '';
    const oldPort = typeof existing.port === 'number' ? existing.port : 21;
    if (fields.host === oldHost && fields.port === oldPort && oldPin.length > 0) {
      config.cert_fingerprint = oldPin;
      if (typeof existing.cert_self_signed === 'boolean') config.cert_self_signed = existing.cert_self_signed;
      return config;
    }

    io.info(fmtFor(io.lang, 'ftp_edit_connecting', `${fields.host}:${fields.port}`));
    let presented: { fingerprint: string; selfSigned: boolean };
    try {
      presented = await this.readServerCert(fields.host, fields.port);
    } catch {
      // Unreachable is not a refusal - the operator still has to finish the edit.
      // The menu runs outside this catch's reach, so a request to go back from it
      // propagates instead of being read as another failure to connect.
      const pin = await this.offlineCertMenu(io, fields.host, fields.port);
      if (pin.length > 0) config.cert_fingerprint = pin;
      return config;
    }
    const trusted = await this.confirmCert(io, fields.host, fields.port, presented);
    config.cert_fingerprint = trusted.fingerprint;
    config.cert_self_signed = trusted.selfSigned;
    return config;
  }

  /**
   * Builds a config object from the BFS CLI pass-through input. Two grammars
   * are accepted and may be combined:
   *
   *   - `--config-file <path>` - JSON `{ host, port, user, password, path,
   *     secure }`. Path resolved via `io.workDir` for relative values.
   *   - inline flags: `--host`, `--port`, `--user`, `--password`, `--path`,
   *     `--secure` (`true|false|1|0|yes|no`, case-insensitive),
   *     `--cert-fingerprint <fp>` and the value-less `--accept-new-cert`.
   *
   * Inline flags override fields from `--config-file` so CI scripts can keep
   * a baseline JSON and substitute per-environment values (e.g. password)
   * via argv. Defaults: `port=21`, `secure=true`. A missing `host` or `path`,
   * and a `path` that is not absolute, are rejected here rather than left to
   * `validateConfig`. `user` and `password` have no defaults and no default
   * value is invented for them - an anonymous server needs neither. The JSON file
   * accepts the same fields, `cert_fingerprint` / `accept_new_cert` included -
   * they carry the basis of trust for a secure connection.
   *
   * @throws ProviderError when `--config-file` is unreadable / malformed,
   *         port/secure flags are invalid, final config fails validation, or the
   *         run declares itself unattended while the assembled config gives no
   *         basis to trust a secure server (no pin, no opt-in) - an `offline`
   *         input is exempt, since it never reaches the medium
   */
  async configureFromFlags(input: CliProviderInput): Promise<Record<string, unknown>> {
    // Secure by default (an explicit `--secure false` / `"secure": false` opts out).
    const config: Record<string, unknown> = { port: 21, secure: true };

    const cfgFile = findStringFlag(input.rawArgs, '--config-file');
    if (cfgFile !== null && cfgFile.length > 0) {
      const absolutePath = path.isAbsolute(cfgFile) ? cfgFile : path.resolve(this.io.workDir, cfgFile);
      const obj = await readJsonObjectFile(absolutePath, 'FTP adapter');
      if (typeof obj.host === 'string') config.host = obj.host;
      if (obj.port !== undefined) {
        const portRaw = obj.port;
        const port = typeof portRaw === 'number' ? portRaw : Number(portRaw);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ProviderError(tFor(this.io.lang, 'ftp_config_port_invalid'));
        }
        config.port = port;
      }
      if (typeof obj.user === 'string') config.user = obj.user;
      if (typeof obj.password === 'string') config.password = obj.password;
      if (typeof obj.path === 'string') config.path = obj.path;
      if (obj.secure !== undefined) config.secure = obj.secure === true;
      if (typeof obj.cert_fingerprint === 'string') {
        if (!isValidCertFingerprint(obj.cert_fingerprint)) {
          throw new ProviderError(tFor(this.io.lang, 'ftp_cert_fingerprint_invalid'));
        }
        config.cert_fingerprint = obj.cert_fingerprint.trim();
      }
      if (obj.accept_new_cert !== undefined) config.accept_new_cert = obj.accept_new_cert === true;
    }

    const inlineHost = findStringFlag(input.rawArgs, '--host');
    if (inlineHost !== null) config.host = inlineHost;

    const inlinePort = findStringFlag(input.rawArgs, '--port');
    if (inlinePort !== null) {
      const port = Number(inlinePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ProviderError(tFor(this.io.lang, 'ftp_inline_port_invalid'));
      }
      config.port = port;
    }

    const inlineUser = findStringFlag(input.rawArgs, '--user');
    if (inlineUser !== null) config.user = inlineUser;

    const inlinePassword = findStringFlag(input.rawArgs, '--password');
    if (inlinePassword !== null) config.password = inlinePassword;

    const inlinePath = findStringFlag(input.rawArgs, '--path');
    if (inlinePath !== null) config.path = inlinePath;

    const inlineSecure = findStringFlag(input.rawArgs, '--secure');
    if (inlineSecure !== null) {
      const v = inlineSecure.toLowerCase();
      if (v === 'true' || v === '1' || v === 'yes') {
        config.secure = true;
      } else if (v === 'false' || v === '0' || v === 'no') {
        config.secure = false;
      } else {
        throw new ProviderError(tFor(this.io.lang, 'ftp_inline_secure_invalid'));
      }
    }

    const inlineCertFp = findStringFlag(input.rawArgs, '--cert-fingerprint');
    if (inlineCertFp !== null) {
      if (!isValidCertFingerprint(inlineCertFp)) {
        throw new ProviderError(tFor(this.io.lang, 'ftp_cert_fingerprint_invalid'));
      }
      config.cert_fingerprint = inlineCertFp.trim();
    }

    // Presence-only flag (no value): checked directly, not via findStringFlag,
    // which would consume the following token (e.g. `--host`) as its value.
    if (input.rawArgs.includes('--accept-new-cert')) {
      config.accept_new_cert = true;
    }

    if (typeof config.host !== 'string' || config.host.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ftp_host_required'));
    }
    if (typeof config.path !== 'string' || config.path.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ftp_path_required'));
    }
    if (!(config.path as string).startsWith('/')) {
      throw new ProviderError(tFor(this.io.lang, 'ftp_path_must_be_absolute'));
    }

    // Two instructions that cannot both hold, decided from the assembled config
    // rather than the raw flags - a fingerprint or an opt-in may equally have
    // come from --config-file. `offline` is exempt: `bfs provider edit` never
    // reaches the server, so a config without a pin is legal there and the
    // trust decision falls to whoever connects later.
    const trustable = typeof config.cert_fingerprint === 'string' || config.accept_new_cert === true;
    if (input.offline !== true && this.io.interactive === false && config.secure === true && !trustable) {
      throw new ProviderError(fmtFor(this.io.lang, 'ftp_cert_trust_conflict', `${config.host}:${config.port}`));
    }

    return config;
  }

  /**
   * Validates a persisted FTP config. Returns an array of human-readable
   * error messages; empty array means the config is valid.
   */
  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const lang = this.io.lang;

    const host = config.host;
    if (typeof host !== 'string' || host.length === 0) {
      errors.push(tFor(lang, 'ftp_validate_host_required'));
    }

    const port = config.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(tFor(lang, 'ftp_validate_port_invalid'));
    }

    const remotePath = config.path;
    if (typeof remotePath !== 'string' || remotePath.length === 0) {
      errors.push(tFor(lang, 'ftp_validate_path_required'));
    } else {
      if (!remotePath.startsWith('/')) {
        errors.push(tFor(lang, 'ftp_validate_path_absolute'));
      }
      if (/[\r\n\0]/.test(remotePath)) {
        errors.push(tFor(lang, 'ftp_control_chars'));
      }
    }

    const certFp = config.cert_fingerprint;
    if (certFp !== undefined && certFp !== null) {
      if (typeof certFp !== 'string' || !isValidCertFingerprint(certFp)) {
        errors.push(tFor(lang, 'ftp_cert_fingerprint_invalid'));
      } else if (config.secure === false) {
        // A certificate pin is meaningless without TLS to present a certificate.
        errors.push(tFor(lang, 'ftp_cert_pin_requires_secure'));
      }
    }

    return errors;
  }

  /**
   * Renders a one-line summary of the FTP config for display
   * (e.g. `bfs provider list`). The password field is masked.
   */
  describeConfig(config: Record<string, unknown>): string {
    const host = typeof config.host === 'string' ? config.host : '';
    const port = typeof config.port === 'number' ? String(config.port) : String(config.port ?? '');
    const user = typeof config.user === 'string' ? config.user : '';
    const remotePath = typeof config.path === 'string' ? config.path : '';
    const secure = config.secure === true;
    const base = fmtFor(this.io.lang, 'ftp_describe_config', host, port, user, remotePath, String(secure));
    const certFp = typeof config.cert_fingerprint === 'string' ? config.cert_fingerprint : null;
    if (certFp === null) return base;
    // The certificate kind is known only when TOFU-capture recorded it; a pin
    // supplied by flag has no captured kind, so show the fingerprint without
    // claiming self-signed vs CA.
    if (typeof config.cert_self_signed !== 'boolean') return fmtFor(this.io.lang, 'ftp_describe_cert_nokind', base, certFp);
    const kind = config.cert_self_signed ? tFor(this.io.lang, 'ftp_cert_kind_self_signed') : tFor(this.io.lang, 'ftp_cert_kind_ca');
    return fmtFor(this.io.lang, 'ftp_describe_cert', base, certFp, kind);
  }

  /**
   * Declares which config fields are secrets. BFS uses this to strip the
   * password from the shard location map (it must never travel in headers) and
   * to know which field to request interactively during disaster recovery.
   */
  getSecretFields(): readonly string[] {
    return ['password'];
  }

  /**
   * Full read/write/verify round-trip against the remote. Must be called
   * after setVaultName() so the probe file lands in the correct sub-dir.
   *
   * Each step wraps its failure in a ProviderError with a "step context"
   * so callers can tell which stage failed (ensureDir / upload / download /
   * compare / cleanup). Probe bytes are deleted on success AND on best-effort
   * cleanup after a mid-flow failure, so the remote stays clean.
   *
   * @throws ProviderError on any step failure
   */
  async probeConnection(): Promise<void> {
    if (this.host.length === 0 || this.basePath.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ftp_probe_incomplete'));
    }
    const lang = this.io.lang;
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const probeName = `__bfs_probe_${nonce}.tmp`;
    const probeData = Buffer.from(`bfs-probe-${nonce}`);
    const vaultDir = this.vaultPath();
    const remotePath = `${vaultDir}/${probeName}`;

    await this.withClient(async (client) => {
      try {
        await client.ensureDir(vaultDir);
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ftp_probe_step_ensure_dir', err instanceof Error ? err.message : String(err)));
      }

      try {
        await client.uploadFrom(Readable.from(probeData), remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ftp_probe_step_upload', err instanceof Error ? err.message : String(err)));
      }

      let downloaded: Buffer;
      try {
        downloaded = await this.downloadToBuffer(client, remotePath);
      } catch (err) {
        await this.bestEffortRemove(client, remotePath);
        throw new ProviderError(fmtFor(lang, 'ftp_probe_step_download', err instanceof Error ? err.message : String(err)));
      }

      if (Buffer.compare(probeData, downloaded) !== 0) {
        await this.bestEffortRemove(client, remotePath);
        throw new ProviderError(tFor(lang, 'ftp_probe_step_compare_remote'));
      }

      try {
        await client.remove(remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ftp_probe_step_cleanup', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /** Silent remove - swallow errors (used in probe cleanup paths). */
  private async bestEffortRemove(client: ftp.Client, remotePath: string): Promise<void> {
    try {
      await client.remove(remotePath);
    } catch {
      // intentional - cleanup after a failure must not mask the original error
    }
  }

  /**
   * Remove that treats "file unavailable" (FTP reply 550) as success - an
   * already-absent shard is a no-op, not a failure. Keeps `delete` idempotent so
   * a re-run (or a shard removed out of band) does not raise a false prune orphan
   * warning; a real failure (permissions, transport) still throws.
   */
  private async idempotentRemove(client: ftp.Client, remotePath: string): Promise<void> {
    try {
      await client.remove(remotePath);
    } catch (err) {
      if (ftpReplyCode(err) === 550) return;
      throw err;
    }
  }
}

// --- Factory + registry ------------------------------------------------------

const ftpFactory: ProviderFactory = {
  lang: 'en',
  displayName: 'FTP/FTPS',
  requiresApiVersion: 2,
  create: (config, io) => new FtpProvider(config, io),
  help(): ProviderHelp {
    return {
      usage: '[--host <h>] [--port <n>] [--user <u>] [--password <p>] ' + '[--path <p>] [--secure <b>] [--cert-fingerprint <fp>] [--accept-new-cert] [--config-file <path>]',
      description: tFor(this.lang, 'ftp_help_description'),
      flags: [
        { flag: '--host <host>', description: tFor(this.lang, 'ftp_help_flag_host_desc') },
        { flag: '--port <port>', description: tFor(this.lang, 'ftp_help_flag_port_desc') },
        { flag: '--user <user>', description: tFor(this.lang, 'ftp_help_flag_user_desc') },
        { flag: '--password <password>', description: tFor(this.lang, 'ftp_help_flag_password_desc') },
        { flag: '--path <path>', description: tFor(this.lang, 'ftp_help_flag_path_desc') },
        { flag: '--secure <bool>', description: tFor(this.lang, 'ftp_help_flag_secure_desc') },
        { flag: '--cert-fingerprint <fp>', description: tFor(this.lang, 'ftp_help_flag_cert_fingerprint_desc') },
        { flag: '--accept-new-cert', description: tFor(this.lang, 'ftp_help_flag_accept_new_cert_desc') },
        { flag: '--config-file <path>', description: tFor(this.lang, 'ftp_help_flag_config_file_desc') },
      ],
      examples: [
        'bfs provider add --ci --name nas --type ftp \\',
        '  --host ftp.example.com --port 21 --user backup \\',
        "  --password '...' --path /backup --secure false",
        '',
        'bfs provider add --ci --name nas --type ftp --config-file ./nas.json',
        '# nas.json:',
        '# {',
        '#   "host": "ftp.example.com",',
        '#   "port": 21,',
        '#   "user": "backup",',
        '#   "password": "...",',
        '#   "path": "/backup",',
        '#   "secure": false',
        '# }',
        '',
        '# Override one field from JSON (e.g. password from CI secrets):',
        'bfs provider add --ci --name nas --type ftp \\',
        '  --config-file ./nas.json --password "$FTP_PASSWORD"',
      ],
    };
  },
};

providerRegistry.register('ftp', ftpFactory);
