import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { Client, type ConnectConfig, type FileEntry, type SFTPWrapper } from 'ssh2';
import { HostKeyDeclinedError, ProviderError } from '../core/errors.js';
import { assertSafeFilename, assertSafeVaultName, isSafeFilename } from '../core/fs-utils.js';
import { hashBuffer, SHA256_BYTES, streamToBuffer } from '../core/hash.js';
import { buildShardHeaderFromBytes, computeShardHeaderSize, SHARD_HEADER_READ_BYTES, sidecarFilename } from '../core/shard-io.js';
import { fmtFor, t, tFor } from '../i18n/index.js';
import type { CliProviderInput, ConfigureEditContext, ProviderConfig, ProviderHelp, ProviderIO, RecoverySecret, RemoteRef, ShardHeader, ShardIdentity, StorageProvider, VerifyShardResult } from '../types/index.js';
import { findStringFlag, readJsonObjectFile } from './flags.js';
import { finishVerifyShard } from './header-verify.js';
import { type ProviderFactory, providerRegistry } from './provider.js';

const CHECKSUM_SIZE = SHA256_BYTES;
const SSH_TIMEOUT_MS = 15_000;
/**
 * Idle timeout for SFTP work after the handshake completes. ssh2's readyTimeout
 * only bounds KEX + auth; once `ready` fires, a stalled-but-alive server would
 * hang readdir/stat/read/write forever with no error. This bounds each operation
 * by INACTIVITY — reset on every received payload — so a legitimately slow large
 * transfer is never cut, only a genuine stall. Mirrors basic-ftp's socket timeout
 * (`FTP_TIMEOUT_MS`), which SSH otherwise lacked.
 */
const SFTP_IDLE_TIMEOUT_MS = 10_000;
const UPLOAD_CHUNK_SIZE = 64 * 1024;
const DEFAULT_SSH_PORT = 22;
/** POSIX S_IFMT mask + S_IFDIR — used to detect a directory from SFTP attrs.mode. */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/** Auth strategy carried in `connection_config.auth_method`. */
type AuthMethod = 'password' | 'key';

/** ssh2 connect auth options: password OR private key (+ optional passphrase). */
type AuthOptions = { password: string } | { privateKey: Buffer; passphrase?: string };

/**
 * Wraps a Buffer in a Readable that emits it as fixed-size chunks. A single
 * multi-MB `Readable.from(buffer)` push loses bytes through some SFTP write
 * pipelines (see `.claude/rules/streaming.md`); 64 KB chunks cooperate with
 * backpressure and remove the truncation.
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

/**
 * Computes the OpenSSH SHA-256 host-key fingerprint: `SHA256:` followed by the
 * base64 of the SHA-256 digest of the raw host-key buffer, with trailing '='
 * padding stripped — the exact form OpenSSH prints and `~/.ssh/known_hosts`
 * comparisons key off.
 */
function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** OpenSSH SHA-256 fingerprint shape: `SHA256:` + base64 of a 32-byte digest
 * (43 base64 chars, optional `=` padding). Used to validate an operator-pasted
 * pin in the offline edit menu before persisting it. */
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}=*$/;

/** True when `value` is a well-formed OpenSSH SHA-256 host-key fingerprint. */
function isValidFingerprint(value: string): boolean {
  return FINGERPRINT_RE.test(value.trim());
}

/**
 * Host-key type preference for ordering offline known_hosts proposals — mirrors
 * ssh2's DEFAULT_SERVER_HOST_KEY negotiation order (ssh-ed25519 > ecdsa > ssh-rsa;
 * see ssh2/lib/protocol/constants.js). The type ssh2 negotiates first is the one
 * that must be pinned, so the highest-preference key is offered (and recommended)
 * first; pinning a lower type than ssh2 will present fails the pin check at push.
 * Lower value = preferred. Unknown types sort last.
 */
const HOST_KEY_TYPE_RANK: Record<string, number> = { 'ssh-ed25519': 0, 'ecdsa-sha2-nistp256': 1, 'ecdsa-sha2-nistp384': 2, 'ecdsa-sha2-nistp521': 3, 'ssh-rsa': 4 };

/** Rank of a known_hosts key type by ssh2 negotiation preference (lower = preferred). */
function hostKeyTypeRank(keyType: string): number {
  return HOST_KEY_TYPE_RANK[keyType] ?? Number.MAX_SAFE_INTEGER;
}

/** Extracts the numeric SFTP status code from an ssh2 error (2 = No-Such-File). */
function sftpErrorCode(err: unknown): Nullable<number> {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return null;
}

/** True when an ssh2 error carries the authentication failure level. */
function isAuthError(err: unknown): boolean {
  return err !== null && typeof err === 'object' && 'level' in err && (err as { level: unknown }).level === 'client-authentication';
}

/** Directory test that works with both ssh2 Stats (isDirectory) and raw attrs.mode. */
function entryIsDirectory(entry: FileEntry): boolean {
  const attrs = entry.attrs as { isDirectory?: () => boolean; mode?: number };
  if (typeof attrs.isDirectory === 'function') return attrs.isDirectory();
  return typeof attrs.mode === 'number' && (attrs.mode & S_IFMT) === S_IFDIR;
}

/**
 * Runs a one-shot SFTP callback op under the idle timeout. Metadata ops
 * (readdir/stat/rename/unlink/mkdir/sftp) are a single request/response, so "no
 * reply within the window" means the server stalled after the handshake — reject
 * instead of hanging forever (ssh2 has no per-op timeout once `ready` fires).
 */
function withSftpTimeout<T>(op: string, run: (done: (err: Error | null | undefined, val?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`SFTP ${op} stalled: no response for ${SFTP_IDLE_TIMEOUT_MS}ms after handshake`)), SFTP_IDLE_TIMEOUT_MS);
    run((err, val) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val as T);
    });
  });
}

/** Promisified `sftp.readdir` (idle-timeout bounded). */
function readdirAsync(sftp: SFTPWrapper, dir: string): Promise<FileEntry[]> {
  return withSftpTimeout<FileEntry[]>('readdir', (done) => sftp.readdir(dir, (err, list) => done(err, list)));
}

/** Promisified `sftp.stat` — returns the byte size via metadata, no payload transfer (idle-timeout bounded). */
function statSizeAsync(sftp: SFTPWrapper, remotePath: string): Promise<number> {
  return withSftpTimeout<number>('stat', (done) => sftp.stat(remotePath, (err, stats) => done(err, stats?.size)));
}

/** Promisified `sftp.rename` (idle-timeout bounded). */
function renameAsync(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return withSftpTimeout<void>('rename', (done) => sftp.rename(from, to, (err) => done(err)));
}

/** Promisified `sftp.unlink` (idle-timeout bounded). */
function unlinkAsync(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return withSftpTimeout<void>('unlink', (done) => sftp.unlink(remotePath, (err) => done(err)));
}

/** Promisified `sftp.mkdir` (idle-timeout bounded). */
function mkdirAsync(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  return withSftpTimeout<void>('mkdir', (done) => sftp.mkdir(remotePath, (err) => done(err)));
}

/**
 * Pipes a source stream into a writable, resolving when the destination has
 * fully committed the bytes and rejecting on error.
 *
 * Resolves on `'close'` as well as `'finish'`: ssh2's SFTP write stream is built
 * with `autoDestroy`/`emitClose` off and destroys itself inside `_final`, so it
 * never emits `'finish'` — it commits the payload and emits `'close'` once the
 * remote handle is closed. Waiting for `'finish'` alone would hang forever. The
 * settled guard keeps the first outcome authoritative: a generic Writable (the
 * test mock) fires both `'finish'` and `'close'`, and on failure the `'error'`
 * must win over any later event.
 *
 * An idle timer (reset on each source chunk) fails the upload if no progress is
 * made for `SFTP_IDLE_TIMEOUT_MS` — a server that stalls mid-write (backpressure
 * pauses the source, so no more chunks flow) can no longer hang push forever.
 */
function pipeToWriteStream(source: Readable, dest: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        dest.destroy();
        reject(err);
      } else resolve();
    };
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => settle(new Error(`SFTP upload stalled: no progress for ${SFTP_IDLE_TIMEOUT_MS}ms mid-transfer`)), SFTP_IDLE_TIMEOUT_MS);
    };
    arm();
    source.on('data', () => arm()).on('error', settle);
    dest
      .on('error', settle)
      .on('finish', () => settle())
      .on('close', () => settle());
    source.pipe(dest);
  });
}

/**
 * Collects a read stream into a Buffer under an idle timeout that resets on every
 * received chunk — a slow-but-progressing transfer is never cut, only a genuine
 * mid-transfer stall (server went silent after `ready`) fails. `transform` shapes
 * the concatenated result; the stream is destroyed on timeout.
 */
function collectStreamIdle(rs: Readable, op: string, transform: (buf: Buffer) => Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        rs.destroy();
        reject(new Error(`SFTP ${op} stalled: no data for ${SFTP_IDLE_TIMEOUT_MS}ms mid-transfer`));
      }, SFTP_IDLE_TIMEOUT_MS);
    };
    arm();
    rs.on('data', (chunk: Buffer | string) => {
      arm();
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    rs.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    rs.on('end', () => {
      clearTimeout(timer);
      resolve(transform(Buffer.concat(chunks)));
    });
  });
}

/** Downloads a remote file fully into a Buffer via an SFTP read stream (idle-timeout bounded). */
function downloadToBuffer(sftp: SFTPWrapper, remotePath: string): Promise<Buffer> {
  return collectStreamIdle(sftp.createReadStream(remotePath), 'download', (buf) => buf);
}

/**
 * Reads at most `maxBytes` from the start of a remote file using SFTP's native
 * ranged read (`{ start, end }`) — the header window is pulled without buffering
 * the full payload (idle-timeout bounded).
 */
function collectRanged(sftp: SFTPWrapper, remotePath: string, maxBytes: number): Promise<Buffer> {
  return collectStreamIdle(sftp.createReadStream(remotePath, { start: 0, end: maxBytes - 1 }), 'ranged read', (buf) => buf.subarray(0, maxBytes));
}

/**
 * StorageProvider backed by an SSH/SFTP server via `ssh2`.
 *
 * Directory layout on the remote server (POSIX paths, always forward-slash even
 * for a Windows SFTP server):
 *   {basePath}/{vault_name}/{filename}
 *
 * Every public method opens a fresh SSH connection + SFTP session, performs the
 * operation, and closes the connection in a `finally` block. This keeps the
 * provider stateless between calls.
 */
export class SshProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'ssh';

  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly basePath: string;
  private readonly authMethod: AuthMethod;
  private readonly privateKeyPath: string;
  // Mutable: connectForRecovery() collects the transport secret interactively at
  // recovery time (stripped from the location map) and assigns it before connecting.
  private password: string;
  private passphrase: string;
  // Pinned host-key fingerprint (config.json + shard headers). Authoritative for
  // trust, but a ~/.ssh/known_hosts @revoked entry still hard-refuses it (fail-closed).
  private readonly hostKeyFingerprint: Nullable<string>;
  // Non-interactive "trust a new host key" opt-in (`--accept-new-host-key`).
  private readonly acceptNewHostKey: boolean;
  private readonly io: ProviderIO;
  private vaultName: Nullable<string> = null;

  constructor(config: ProviderConfig, io: ProviderIO) {
    // Lazy init — an incomplete config is allowed so the CLI can construct a
    // placeholder instance and call configureInteractive/configureFromFlags
    // before persisting. Validation happens in validateConfig() and at use.
    this.id = config.id;
    this.io = io;
    const c = config.config;
    this.host = typeof c.host === 'string' ? c.host : '';
    this.port = typeof c.port === 'number' ? c.port : DEFAULT_SSH_PORT;
    this.user = typeof c.user === 'string' ? c.user : '';
    this.basePath = typeof c.path === 'string' ? c.path : '';
    this.authMethod = c.auth_method === 'key' ? 'key' : 'password';
    this.privateKeyPath = typeof c.private_key_path === 'string' ? c.private_key_path : '';
    this.password = typeof c.password === 'string' ? c.password : '';
    this.passphrase = typeof c.passphrase === 'string' ? c.passphrase : '';
    this.hostKeyFingerprint = typeof c.host_key_fingerprint === 'string' ? c.host_key_fingerprint : null;
    this.acceptNewHostKey = c.accept_new_host_key === true;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Resolves ssh2 auth options for this instance, reading the private key file for key auth. */
  private async authOptions(): Promise<AuthOptions> {
    if (this.authMethod === 'key' && this.privateKeyPath.length > 0) {
      let keyBuf: Buffer;
      try {
        keyBuf = await fs.readFile(this.privateKeyPath);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'ssh_key_unreadable', this.privateKeyPath, err instanceof Error ? err.message : String(err)));
      }
      return this.passphrase.length > 0 ? { privateKey: keyBuf, passphrase: this.passphrase } : { privateKey: keyBuf };
    }
    return { password: this.password };
  }

  /**
   * Decides whether to trust the presented host key. Revocation is checked first
   * and wins over everything (fail-closed): an `@revoked` entry in
   * ~/.ssh/known_hosts hard-refuses the key — surfacing the reason — even when its
   * fingerprint is pinned. Otherwise the pinned fingerprint is authoritative; then
   * a `known_hosts` trust line; then interactive TOFU, or — in non-interactive
   * mode — the `acceptNew` opt-in. `acceptNew` is passed in rather than read from
   * the instance so the configure-time capture can honor `--accept-new-host-key`
   * from the current invocation (the placeholder instance built for `provider add`
   * has no such flag on it yet).
   */
  private async decideHostKeyTrust(io: ProviderIO, host: string, port: number, user: string, pin: Nullable<string>, key: Buffer, acceptNew: boolean): Promise<boolean> {
    const fp = sshFingerprint(key);
    const known = await this.knownHostsLookup(host, port, key);
    if (known === 'revoked') {
      // @revoked = compromised key: hard refuse, beating a pinned fingerprint. The
      // ssh2 verifier turns the false into a generic transport error, so surface
      // the real reason here where both callers (runtime + capture) pass through.
      io.warn(fmtFor(io.lang, 'ssh_host_key_revoked', `${user}@${host}:${port}`));
      return false;
    }
    if (pin !== null && pin.length > 0) return fp === pin;
    if (known === 'trusted') return true;
    if (io.interactive === false) return acceptNew;
    return io.confirm(fmtFor(io.lang, 'ssh_host_key_confirm', `${user}@${host}:${port}`, fp));
  }

  /**
   * Classifies `key` for `host` against ~/.ssh/known_hosts: `trusted` (a normal
   * line matches), `revoked` (a matching `@revoked` line — the key is marked
   * compromised, so it must be hard-refused), or `unknown`. Handles plain
   * hostnames, `[host]:port` for non-default ports, and hashed `|1|salt|hash`
   * entries (HMAC-SHA1). `@revoked` wins over a stale trust line. Other markers
   * (e.g. `@cert-authority`) are unsupported and skipped (fail-closed). Never
   * throws — a missing/unreadable file means `unknown`.
   */
  private async knownHostsLookup(host: string, port: number, key: Buffer): Promise<'trusted' | 'revoked' | 'unknown'> {
    const keyB64 = key.toString('base64');
    let trusted = false;
    for (const entry of await this.matchingKnownHostsEntries(host, port)) {
      if (entry.keyB64 !== keyB64) continue;
      if (entry.revoked) return 'revoked'; // compromised — takes precedence over any trust line
      trusted = true;
    }
    return trusted ? 'trusted' : 'unknown';
  }

  /**
   * Reads ~/.ssh/known_hosts and returns every entry whose host field matches
   * `host` (plain, `[host]:port`, or hashed `|1|salt|hash`), each as
   * `{ keyType, keyB64, revoked }`. Unsupported markers (e.g. `@cert-authority`)
   * are skipped (fail-closed). Never throws — a missing/unreadable file yields an
   * empty list. Shared by `knownHostsLookup` (classify a presented key) and
   * `knownHostsCandidates` (enumerate keys for the offline edit menu).
   */
  private async matchingKnownHostsEntries(host: string, port: number): Promise<Array<{ keyType: string; keyB64: string; revoked: boolean }>> {
    let content: string;
    try {
      content = await fs.readFile(path.join(os.homedir(), '.ssh', 'known_hosts'), 'utf8');
    } catch {
      return [];
    }
    const plainToken = port === DEFAULT_SSH_PORT ? host : `[${host}]:${port}`;
    const entries: Array<{ keyType: string; keyB64: string; revoked: boolean }> = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const revoked = trimmed.startsWith('@revoked ');
      if (trimmed.startsWith('@') && !revoked) continue; // unsupported marker (e.g. @cert-authority)
      // Normal line: <hosts> <keytype> <keyB64>. @revoked shifts each field by one.
      const offset = revoked ? 1 : 0;
      const parts = trimmed.split(/\s+/);
      if (parts.length < offset + 3) continue;
      const hostsField = parts[offset];
      const keyType = parts[offset + 1];
      const keyB64 = parts[offset + 2];
      if (hostsField === undefined || keyType === undefined || keyB64 === undefined) continue;
      if (!this.knownHostsHostMatches(hostsField, plainToken, host, port)) continue;
      entries.push({ keyType, keyB64, revoked });
    }
    return entries;
  }

  /** Matches a known_hosts host field (comma list; plain, bracketed, or hashed) against the target. */
  private knownHostsHostMatches(hostsField: string, plainToken: string, host: string, port: number): boolean {
    for (const token of hostsField.split(',')) {
      if (token === plainToken) return true;
      if (port === DEFAULT_SSH_PORT && token === host) return true;
      if (token.startsWith('|1|')) {
        const segments = token.split('|');
        if (segments.length === 4) {
          const salt = Buffer.from(segments[2], 'base64');
          const expected = segments[3];
          const candidates = port === DEFAULT_SSH_PORT ? [host] : [`[${host}]:${port}`, host];
          for (const candidate of candidates) {
            const mac = createHmac('sha1', salt).update(candidate).digest('base64');
            if (mac === expected) return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * Opens a fresh SSH connection (runtime auth), waits for `ready`, and applies
   * the host-key decision via `hostVerifier`. Rejects with the raw ssh2 error.
   */
  private establish(conn: Client, auth: AuthOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const cfg: ConnectConfig = {
        host: this.host,
        port: this.port,
        username: this.user,
        readyTimeout: SSH_TIMEOUT_MS,
        hostVerifier: (key: Buffer, cb: (valid: boolean) => void) => {
          // ssh2's hostVerifier is synchronous; bridge the async trust decision to
          // its callback (the result is delivered via cb, so the promise is voided).
          void this.decideHostKeyTrust(this.io, this.host, this.port, this.user, this.hostKeyFingerprint, key, this.acceptNewHostKey)
            .then(cb)
            .catch(() => cb(false));
        },
        ...auth,
      };
      conn.on('ready', () => resolve()).on('error', reject);
      conn.connect(cfg);
    });
  }

  /** Opens the SFTP session on a ready connection (idle-timeout bounded). */
  private openSftp(conn: Client): Promise<SFTPWrapper> {
    return withSftpTimeout<SFTPWrapper>('sftp', (done) => conn.sftp((err, sftp) => done(err ?? (sftp ? null : new Error('sftp session unavailable')), sftp)));
  }

  /**
   * Opens a fresh connection + SFTP session, runs `op`, and always closes the
   * connection. All exceptions are wrapped in ProviderError.
   */
  private async withClient<T>(op: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const conn = new Client();
    try {
      this.io.debug(`SSH connecting to ${this.host}:${this.port}`);
      await this.establish(conn, await this.authOptions());
      const sftp = await this.openSftp(conn);
      return await op(sftp);
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(fmtFor(this.io.lang, 'ssh_operation_failed', this.host, String(this.port), err instanceof Error ? err.message : String(err)));
    } finally {
      conn.end();
    }
  }

  /**
   * Connects far enough to read the host key (presented during key exchange,
   * before authentication), applies the TOFU trust decision, and returns the
   * accepted fingerprint. Used by `configureInteractive` and by the
   * `--accept-new-host-key` branch of `configureFromFlags` so the pin lands in
   * the config `bfs init` / `bfs provider add` persists. `acceptNew` carries the
   * current invocation's `--accept-new-host-key` opt-in for the non-interactive
   * decision. Does not require the private key file to be readable: the
   * fingerprint is resolved in the host-key verifier, before any credential is
   * needed. ssh2 still proceeds to a username-only auth attempt after the key is
   * accepted — it fails on the server (a harmless failed-login entry) and we
   * never await it. Throws ProviderError when the operator declines.
   */
  private async captureHostKey(io: ProviderIO, host: string, port: number, user: string, acceptNew: boolean): Promise<string> {
    const conn = new Client();
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        // A refused key (declined / @revoked) and ssh2's follow-up 'error' event
        // race to settle: cb(false) makes ssh2 emit a raw "verification failed"
        // transport error. Mark the refusal BEFORE cb() so whichever path settles
        // first reports HostKeyDeclinedError — the edit flow must tell a deliberate
        // refusal (abort) apart from an unreachable server (offline fallback).
        let declined = false;
        const declinedError = (): HostKeyDeclinedError => new HostKeyDeclinedError(fmtFor(io.lang, 'ssh_host_key_declined', `${user}@${host}:${port}`));
        conn.on('error', (err) => {
          if (!settled) {
            settled = true;
            reject(declined ? declinedError() : err);
          }
        });
        const cfg: ConnectConfig = {
          host,
          port,
          username: user,
          readyTimeout: SSH_TIMEOUT_MS,
          hostVerifier: (key: Buffer, cb: (valid: boolean) => void) => {
            const fp = sshFingerprint(key);
            // Bridge the async trust decision to ssh2's synchronous hostVerifier
            // callback; the promise settles the outer capture Promise, so void it.
            void this.decideHostKeyTrust(io, host, port, user, null, key, acceptNew)
              .then((ok) => {
                if (!ok) declined = true;
                cb(ok);
                if (settled) return;
                settled = true;
                if (ok) resolve(fp);
                else reject(declinedError());
              })
              .catch((err) => {
                cb(false);
                if (!settled) {
                  settled = true;
                  reject(err);
                }
              });
          },
        };
        conn.connect(cfg);
      });
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(fmtFor(io.lang, 'ssh_operation_failed', host, String(port), err instanceof Error ? err.message : String(err)));
    } finally {
      conn.end();
    }
  }

  /**
   * Returns the remote vault directory path: {basePath}/{vaultName} (POSIX).
   * @throws ProviderError if setVaultName() has not been called, or the assembled
   *   path carries a line break / NUL. Traversal (`..`, separators) is rejected
   *   first by assertSafeVaultName (UnsafePathError).
   */
  private vaultPath(): string {
    if (this.vaultName === null) {
      throw new ProviderError('setVaultName() must be called before any file operation');
    }
    assertSafeVaultName(this.vaultName);
    const full = `${this.basePath}/${this.vaultName}`;
    if (/[\r\n\0]/.test(full)) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_control_chars'));
    }
    return full;
  }

  /**
   * Builds {vaultPath}/{filename}, rejecting a filename that is not a safe path
   * segment (traversal / separator / control char) BEFORE it is joined — so a
   * crafted ref.path or a hostile server's readdir entry cannot escape the vault.
   */
  private remoteFile(filename: string): string {
    assertSafeFilename(filename);
    return `${this.vaultPath()}/${filename}`;
  }

  /** Recursively creates a remote directory, ignoring "already exists" errors. */
  private async ensureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
    const parts = dir.split('/').filter((p) => p.length > 0);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      try {
        await mkdirAsync(sftp, current);
      } catch {
        // Directory already exists (or a parent the server auto-creates) — the
        // subsequent upload surfaces any real permission failure.
      }
    }
  }

  /**
   * Uploads `buffer` to `remotePath` (chunked), then verifies the stored size via
   * `stat`. SFTP `stat` is deterministic, so a single post-upload check replaces
   * the FTP SIZE-retry loop.
   */
  private async uploadBuffer(sftp: SFTPWrapper, remotePath: string, buffer: Buffer, label: string): Promise<void> {
    await pipeToWriteStream(bufferToChunkedStream(buffer), sftp.createWriteStream(remotePath));
    const stored = await statSizeAsync(sftp, remotePath);
    if (stored !== buffer.length) {
      throw new ProviderError(fmtFor(this.io.lang, 'ssh_size_mismatch', label, String(buffer.length), String(stored)));
    }
  }

  /** Silent unlink — swallows errors (used in relocate/cleanup paths). */
  private async bestEffortUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    try {
      await unlinkAsync(sftp, remotePath);
    } catch {
      // intentional — cleanup must not mask the original error
    }
  }

  /**
   * Unlink that treats "no such file" (SFTP status 2) as success — an
   * already-absent shard is a no-op, not a failure. Keeps `delete` idempotent so
   * a re-run (or a shard removed out of band) does not raise a false prune
   * orphan warning; a real failure (permissions, transport) still throws.
   */
  private async idempotentUnlink(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    try {
      await unlinkAsync(sftp, remotePath);
    } catch (err) {
      if (sftpErrorCode(err) === 2) return;
      throw err;
    }
  }

  /**
   * Opens a dedicated connection and returns the shard's header window (at most
   * maxBytes) WITHOUT wrapping errors, so the caller can classify raw ssh2
   * failures (code 2 = missing, level 'client-authentication' = auth). Always
   * closes the connection.
   */
  private async readHeaderWindowDirect(remotePath: string, maxBytes: number): Promise<Buffer> {
    const conn = new Client();
    try {
      await this.establish(conn, await this.authOptions());
      const sftp = await this.openSftp(conn);
      const totalSize = await statSizeAsync(sftp, remotePath);
      return totalSize <= maxBytes ? await downloadToBuffer(sftp, remotePath) : await collectRanged(sftp, remotePath, maxBytes);
    } finally {
      conn.end();
    }
  }

  // ─── StorageProvider interface ────────────────────────────────────────────

  /**
   * Verifies SSH connectivity by connecting and listing the base path.
   * @throws ProviderError if the connection or directory listing fails.
   */
  async authenticate(): Promise<void> {
    await this.withClient(async (sftp) => {
      await readdirAsync(sftp, this.basePath);
    });
  }

  /**
   * Attempts a recovery authentication, distinguishing a rejected credential from
   * a transport failure. Returns true when it authenticates; returns false when
   * the server rejects the credential (ssh2 `level: 'client-authentication'`);
   * throws a ProviderError for a transport failure (connection refused/lost, host
   * key declined). Recovery uses this so a transport failure surfaces instead of
   * being mistaken for a wrong secret and driving an interactive re-prompt. Unlike
   * `withClient`, this classifies the raw ssh2 error before it is wrapped.
   */
  private async tryRecoveryAuth(): Promise<boolean> {
    const conn = new Client();
    try {
      await this.establish(conn, await this.authOptions());
      const sftp = await this.openSftp(conn);
      await readdirAsync(sftp, this.basePath);
      return true;
    } catch (err) {
      if (isAuthError(err)) return false;
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(fmtFor(this.io.lang, 'ssh_operation_failed', this.host, String(this.port), err instanceof Error ? err.message : String(err)));
    } finally {
      conn.end();
    }
  }

  /**
   * Sets the vault sub-directory name. Must be called before any file operations.
   * @param name - Vault name (used as subdirectory under basePath)
   */
  setVaultName(name: string): void {
    this.vaultName = name;
  }

  /**
   * Recovery hook: shows the operator the SSH target (user@host:port, path) and
   * the pinned host-key fingerprint BEFORE any secret is sent, and lets them
   * decline. Once approved, a pooled secret is tried first, then the password is
   * prompted with retry.
   *
   * @param io      - ProviderIO for the host confirmation and secret prompt
   * @param pool    - secrets already collected this recovery, tried before prompting
   * @param options - trustLocation skips the confirmation (unattended recovery)
   * @returns the secret that authenticated (added to the recovery pool)
   * @throws ProviderError when the operator declines (host or blank secret)
   */
  async connectForRecovery(io: ProviderIO, pool: readonly RecoverySecret[], options?: { trustLocation?: boolean }): Promise<string | null> {
    const target = `${this.user}@${this.host}:${this.port}`;
    const remotePath = this.basePath.length > 0 ? this.basePath : '/';
    const fingerprint = this.hostKeyFingerprint ?? tFor(this.io.lang, 'ssh_recovery_unpinned');
    if (options?.trustLocation === true) {
      io.info(fmtFor(this.io.lang, 'ssh_recovery_target', target, remotePath, fingerprint));
    } else {
      const approved = await io.confirm(fmtFor(this.io.lang, 'ssh_recovery_confirm_host', target, remotePath, fingerprint));
      if (!approved) {
        throw new ProviderError(fmtFor(this.io.lang, 'ssh_recovery_declined', target));
      }
    }
    // The secret to collect depends on the auth method: a password for password
    // auth, the private-key passphrase for key auth (the key body is not a secret —
    // it lives at private_key_path, supplied by the operator out of band).
    const isKey = this.authMethod === 'key';
    const applySecret = (secret: string): void => {
      if (isKey) this.passphrase = secret;
      else this.password = secret;
    };

    // An unencrypted key needs no secret — try it as-is before prompting.
    if (isKey) {
      try {
        await this.authenticate();
        return null;
      } catch {
        // key is passphrase-protected (or unreachable) — collect the passphrase below
      }
    }

    for (let i = pool.length - 1; i >= 0; i--) {
      applySecret(pool[i].value);
      // A transport failure (not a rejected secret) propagates out of
      // tryRecoveryAuth: the host is unreachable, so trying more secrets or
      // prompting is pointless — surface it.
      if (await this.tryRecoveryAuth()) return pool[i].value;
      // pooled secret rejected by the server — try the next one
    }

    // Non-interactive recovery has no operator to prompt: with no pooled secret
    // that authenticated, fail with a clear error instead of blocking on a closed
    // stdin (and never mistaking the earlier transport failure for a wrong secret).
    if (io.interactive === false) {
      throw new ProviderError(fmtFor(this.io.lang, 'ssh_recovery_no_secret_noninteractive', target));
    }

    const promptKey = isKey ? 'ssh_recovery_passphrase' : 'ssh_recovery_password';
    for (;;) {
      const secret = await io.askSecret(fmtFor(this.io.lang, promptKey, target));
      if (secret.length === 0) {
        throw new ProviderError(fmtFor(this.io.lang, 'ssh_recovery_declined', target));
      }
      applySecret(secret);
      if (await this.tryRecoveryAuth()) return secret;
      // wrong secret — re-prompt
    }
  }

  /**
   * Uploads a shard to {basePath}/{vaultName}/{shardFilename}. Buffers the stream
   * to compute the SHA-256 hash before uploading.
   *
   * @param shardFilename - Target filename, e.g. "shard_0.bfs.1"
   * @param data          - Readable stream of the full shard
   * @param _size         - Total byte size (unused — SFTP needs no Content-Length)
   * @returns RemoteRef with provider_id, filename, and SHA-256 hash
   * @throws ProviderError on upload failure
   */
  async upload(shardFilename: string, data: Readable, _size: number): Promise<RemoteRef> {
    const buffer = await streamToBuffer(data);
    const hash = hashBuffer(buffer);
    const vaultDir = this.vaultPath();

    await this.withClient(async (sftp) => {
      await this.ensureDir(sftp, vaultDir);
      await this.uploadBuffer(sftp, `${vaultDir}/${shardFilename}`, buffer, shardFilename);
      // A fresh shard carries a fresh in-shard header, so a stale sidecar for this
      // filename (from a prior relocate) must go — else it would shadow the new
      // header on the sidecar-aware read-path.
      await this.bestEffortUnlink(sftp, `${vaultDir}/${sidecarFilename(shardFilename)}`);
    });

    return { provider_id: this.id, path: shardFilename, hash };
  }

  /**
   * Downloads a shard as a Readable stream. The file is buffered in memory
   * because the connection closes after withClient returns.
   *
   * @param ref - RemoteRef returned by upload() or list()
   * @returns Readable stream of the full shard binary
   * @throws ProviderError if the download fails
   */
  async download(ref: RemoteRef): Promise<Readable> {
    const remotePath = this.remoteFile(ref.path);
    const buffer = await this.withClient(async (sftp) => downloadToBuffer(sftp, remotePath));
    return Readable.from(buffer);
  }

  /**
   * Deletes a shard file (and its header sidecar) identified by ref.
   * @param ref - RemoteRef of the shard to delete
   * @throws ProviderError if the file cannot be deleted
   */
  async delete(ref: RemoteRef): Promise<void> {
    assertSafeFilename(ref.path);
    const vaultDir = this.vaultPath();
    await this.withClient(async (sftp) => {
      await this.idempotentUnlink(sftp, `${vaultDir}/${ref.path}`);
      await this.bestEffortUnlink(sftp, `${vaultDir}/${sidecarFilename(ref.path)}`);
    });
  }

  /**
   * Renames a shard file on the SFTP server.
   * @param ref         - RemoteRef of the existing file
   * @param newFilename - New bare filename (not full path)
   * @returns New RemoteRef pointing to the renamed file (no hash)
   * @throws ProviderError on failure
   */
  async rename(ref: RemoteRef, newFilename: string): Promise<RemoteRef> {
    assertSafeFilename(ref.path);
    assertSafeFilename(newFilename);
    const vaultDir = this.vaultPath();
    await this.withClient(async (sftp) => {
      await renameAsync(sftp, `${vaultDir}/${ref.path}`, `${vaultDir}/${newFilename}`);
    });
    return { provider_id: this.id, path: newFilename };
  }

  /**
   * Replaces the binary header of an existing shard, keeping the RS payload
   * unchanged and recomputing the trailing SHA-256 checksum. SFTP payload is
   * write-once, so the shard is downloaded, modified in memory, and re-uploaded.
   *
   * @param ref        - RemoteRef of the shard to update
   * @param headerData - New serialized header (magic … end of location map)
   * @returns Updated RemoteRef (same path, no hash)
   * @throws ProviderError on failure or if the shard is too short
   */
  async updateShardHeader(ref: RemoteRef, headerData: Buffer): Promise<RemoteRef> {
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (sftp) => {
      const existing = await downloadToBuffer(sftp, remotePath);

      const oldHeaderSize = computeShardHeaderSize(existing);
      if (existing.length < oldHeaderSize + CHECKSUM_SIZE) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_short_shard', ref.path));
      }

      const payload = existing.subarray(oldHeaderSize, existing.length - CHECKSUM_SIZE);
      const newBody = Buffer.concat([headerData, payload]);
      const newChecksum = Buffer.from(hashBuffer(newBody), 'hex');
      const newShard = Buffer.concat([newBody, newChecksum]);

      await this.uploadBuffer(sftp, remotePath, newShard, ref.path);
      return { provider_id: this.id, path: ref.path };
    });
  }

  /**
   * Lists shard files in the vault directory, optionally filtered by prefix.
   * @param prefix - Optional filename prefix filter (e.g. "shard_0")
   * @returns Array of RemoteRef (hash not populated)
   */
  async list(prefix?: string): Promise<RemoteRef[]> {
    return this.withClient(async (sftp) => {
      let entries: FileEntry[];
      try {
        entries = await readdirAsync(sftp, this.vaultPath());
      } catch {
        return [];
      }
      // Drop directories and any name that is not a safe segment — a hostile
      // server could return a traversal filename from readdir (L2).
      const files = entries.filter((e) => !entryIsDirectory(e) && isSafeFilename(e.filename));
      const filtered = prefix ? files.filter((e) => e.filename.startsWith(prefix)) : files;
      return filtered.map((e) => ({ provider_id: this.id, path: e.filename }));
    });
  }

  /**
   * Returns the size of a shard via SFTP `stat` — no payload transfer.
   * @param ref - RemoteRef of the shard
   * @returns Size in bytes
   * @throws ProviderError if the file is missing or `stat` fails
   */
  async getSize(ref: RemoteRef): Promise<number> {
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (sftp) => {
      try {
        return await statSizeAsync(sftp, remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_stat_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * Reads at most `maxBytes` bytes from the start of the shard — enough for the
   * header without buffering the full payload (SFTP native ranged read).
   *
   * @param ref      - RemoteRef of the shard
   * @param maxBytes - Maximum byte count to return (must be > 0)
   * @returns Buffer of `min(file_size, maxBytes)` bytes
   * @throws ProviderError on transport failure or missing shard
   */
  async downloadHeader(ref: RemoteRef, maxBytes: number): Promise<Buffer> {
    if (maxBytes <= 0) {
      throw new ProviderError(fmtFor(this.io.lang, 'provider_download_header_invalid_max_bytes', String(maxBytes)));
    }
    const remotePath = this.remoteFile(ref.path);
    return this.withClient(async (sftp) => {
      let totalSize: number;
      try {
        totalSize = await statSizeAsync(sftp, remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_stat_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
      if (totalSize <= maxBytes) {
        return downloadToBuffer(sftp, remotePath);
      }
      try {
        return await collectRanged(sftp, remotePath, maxBytes);
      } catch (err) {
        throw new ProviderError(fmtFor(this.io.lang, 'provider_header_read_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
    });
  }

  /**
   * Lists vault sub-directories under basePath.
   * @returns Array of vault names (directory names)
   * @throws ProviderError if basePath cannot be read
   */
  async listVaults(): Promise<string[]> {
    return this.withClient(async (sftp) => {
      const entries = await readdirAsync(sftp, this.basePath);
      return entries.filter((e) => entryIsDirectory(e)).map((e) => e.filename);
    });
  }

  /**
   * Checks whether the SSH server is reachable by connecting and disconnecting.
   * Never throws — returns false on any error.
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.withClient(async () => true);
    } catch {
      return false;
    }
  }

  // ─── Header storage strategy + verification ───────────────────────────────

  /** SSH keeps a relocated shard's header in an `hdr_` sidecar next to it. */
  usesSidecar(): boolean {
    return true;
  }

  /**
   * Uploads the header sidecar (BFSH bytes) to `hdr_i.bfs.V` next to the shard.
   * @param ref          - RemoteRef of the shard the sidecar belongs to
   * @param sidecarBytes - Sidecar payload in BFSH format
   * @throws ProviderError on upload failure
   */
  async uploadHeaderSidecar(ref: RemoteRef, sidecarBytes: Buffer): Promise<void> {
    const vaultDir = this.vaultPath();
    const name = sidecarFilename(ref.path);
    await this.withClient(async (sftp) => {
      await this.ensureDir(sftp, vaultDir);
      await this.uploadBuffer(sftp, `${vaultDir}/${name}`, sidecarBytes, name);
    });
  }

  /**
   * Downloads the header sidecar `hdr_i.bfs.V`, or null when none exists (SFTP
   * status 2 = No-Such-File).
   * @param ref       - RemoteRef of the shard
   * @param _maxBytes - Byte cap (a sidecar is inherently small; read in full)
   * @returns Sidecar bytes (BFSH format) or null when absent
   * @throws ProviderError on a transport failure other than "not found"
   */
  async downloadHeaderSidecar(ref: RemoteRef, _maxBytes: number): Promise<Buffer | null> {
    assertSafeFilename(ref.path);
    const remotePath = `${this.vaultPath()}/${sidecarFilename(ref.path)}`;
    return this.withClient(async (sftp) => {
      try {
        await statSizeAsync(sftp, remotePath);
      } catch (err) {
        if (sftpErrorCode(err) === 2) return null;
        throw new ProviderError(fmtFor(this.io.lang, 'provider_header_read_failed', remotePath, err instanceof Error ? err.message : String(err)));
      }
      return downloadToBuffer(sftp, remotePath);
    });
  }

  /**
   * Verifies the shard identity by reading only its header window and comparing
   * the plaintext vault_id / shard_index / version. Reads over a dedicated
   * connection so raw ssh2 failures classify: level 'client-authentication' →
   * auth_failed, SFTP code 2 → not_found, else unverifiable.
   *
   * @param ref      - RemoteRef of the shard
   * @param expected - Identity the shard is expected to carry
   * @returns { ok: true } or a classified failure
   */
  async verifyShard(ref: RemoteRef, expected: ShardIdentity): Promise<VerifyShardResult> {
    const lang = this.io.lang;
    const remotePath = this.remoteFile(ref.path);

    let headerBytes: Buffer;
    try {
      headerBytes = await this.readHeaderWindowDirect(remotePath, SHARD_HEADER_READ_BYTES);
    } catch (err) {
      if (isAuthError(err)) {
        return { ok: false, reason: 'auth_failed', detail: fmtFor(lang, 'verify_shard_auth_failed', this.id, ref.path) };
      }
      if (sftpErrorCode(err) === 2) {
        return { ok: false, reason: 'not_found', detail: fmtFor(lang, 'verify_shard_not_found', ref.path) };
      }
      return { ok: false, reason: 'unverifiable', detail: fmtFor(lang, 'verify_shard_unverifiable', this.id, ref.path) };
    }

    let header: ShardHeader;
    try {
      header = buildShardHeaderFromBytes(headerBytes);
    } catch (err) {
      return { ok: false, reason: 'corrupted', detail: fmtFor(lang, 'verify_shard_corrupted', ref.path, err instanceof Error ? err.message : String(err)) };
    }

    return finishVerifyShard(header, expected, lang);
  }

  // ─── Configuration lifecycle ──────────────────────────────────────────────

  /**
   * Prompts for the SSH connection fields (host, port, user, auth, path) via
   * ProviderIO — everything except the host-key trust step. Shared by the add
   * flow (configureInteractive) and the edit flow (configureInteractiveForEdit).
   * The private key is collected as a PATH only, never the key body.
   * @returns the collected fields; `authFields` is spread into the final config
   */
  private async collectSshFields(io: ProviderIO): Promise<{ host: string; port: number; user: string; authFields: Record<string, unknown>; path: string }> {
    const host = (await io.ask(t('ssh_host_prompt'))).trim();
    const portStr = (await io.ask(t('ssh_port_prompt'))).trim();
    const user = (await io.ask(t('ssh_user_prompt'))).trim();
    const method = await io.choose(t('ssh_auth_method_prompt'), [t('ssh_auth_password'), t('ssh_auth_key')]);

    let authFields: Record<string, unknown>;
    if (method === t('ssh_auth_key')) {
      const keyPath = (await io.ask(t('ssh_private_key_prompt'))).trim();
      const passphrase = await io.askSecret(t('ssh_passphrase_prompt'));
      authFields = passphrase.length > 0 ? { auth_method: 'key', private_key_path: keyPath, passphrase } : { auth_method: 'key', private_key_path: keyPath };
    } else {
      const password = await io.askSecret(t('ssh_password_prompt'));
      authFields = { auth_method: 'password', password };
    }

    const remotePath = (await io.ask(t('ssh_path_prompt'))).trim();
    const port = portStr.length === 0 ? DEFAULT_SSH_PORT : Number(portStr);
    return { host, port, user, authFields, path: remotePath };
  }

  /**
   * Interactively prompts for all SSH fields via ProviderIO, performs the TOFU
   * host-key trust step (pinning the fingerprint), and returns a config object.
   * TOFU lives here — not in probeConnection — because `bfs init` persists only
   * this result, so the pin must be captured at configure time to travel with
   * the backup.
   *
   * @throws HostKeyDeclinedError when the operator declines the host key
   */
  async configureInteractive(io: ProviderIO): Promise<Record<string, unknown>> {
    const { host, port, user, authFields, path: remotePath } = await this.collectSshFields(io);
    const fingerprint = await this.captureHostKey(io, host, port, user, false);
    return { host, port, user, ...authFields, path: remotePath, host_key_fingerprint: fingerprint };
  }

  /**
   * Interactive `bfs provider edit` flow. Collects the fields, then resolves the
   * host-key pin online-first with an offline fallback:
   *   - host AND port unchanged and already pinned → reuse the pin without
   *     contacting the server (a credential/path edit stays fully local);
   *   - otherwise dial the server for a live TOFU confirmation. A deliberate
   *     refusal (declined key or @revoked) aborts; an unreachable server drops to
   *     an offline menu (paste a fingerprint / use ~/.ssh/known_hosts / leave
   *     unset / cancel) so the edit still completes.
   *
   * @param io  - ProviderIO for prompts and diagnostics
   * @param ctx - carries the existing connection-config (old host/port/pin)
   * @throws HostKeyDeclinedError when the operator refuses the host key, the
   *   presented key is @revoked, or the offline menu is cancelled
   */
  async configureInteractiveForEdit(io: ProviderIO, ctx: ConfigureEditContext): Promise<Record<string, unknown>> {
    const { host, port, user, authFields, path: remotePath } = await this.collectSshFields(io);
    const build = (fingerprint: string): Record<string, unknown> => ({ host, port, user, ...authFields, path: remotePath, host_key_fingerprint: fingerprint });

    const oldHost = typeof ctx.existingConfig.host === 'string' ? ctx.existingConfig.host : '';
    const oldPort = typeof ctx.existingConfig.port === 'number' ? ctx.existingConfig.port : DEFAULT_SSH_PORT;
    const oldPin = typeof ctx.existingConfig.host_key_fingerprint === 'string' ? ctx.existingConfig.host_key_fingerprint : '';

    // Server identity unchanged and already pinned → reuse the pin, no contact.
    if (host === oldHost && port === oldPort && oldPin.length > 0) {
      return build(oldPin);
    }

    // New (or never-pinned) server identity: try the medium first for a live TOFU.
    io.info(fmtFor(io.lang, 'ssh_edit_connecting', `${user}@${host}:${port}`));
    try {
      const fingerprint = await this.captureHostKey(io, host, port, user, false);
      return build(fingerprint);
    } catch (err) {
      // A deliberate refusal (declined key / @revoked) aborts the edit; only an
      // unreachable server falls through to the offline menu.
      if (err instanceof HostKeyDeclinedError) throw err;
      return build(await this.offlineHostKeyMenu(io, host, port));
    }
  }

  /**
   * Offline host-key menu shown when the server is unreachable during an edit.
   * Each non-revoked `~/.ssh/known_hosts` key for the host is offered as a concrete
   * proposal showing its fingerprint, ordered by ssh2 negotiation preference with
   * the top (the type ssh2 will present) flagged recommended — so the operator does
   * not pin a type that will not match. Returns the fingerprint to pin — an empty
   * string means "save without a pin".
   * @throws HostKeyDeclinedError when the operator cancels
   */
  private async offlineHostKeyMenu(io: ProviderIO, host: string, port: number): Promise<string> {
    // Copy before sorting so a future caller/cache that shares the array
    // knownHostsCandidates returns can never be corrupted by this reorder.
    const candidates = (await this.knownHostsCandidates(host, port)).slice().sort((a, b) => hostKeyTypeRank(a.keyType) - hostKeyTypeRank(b.keyType));
    const proposals = candidates.map((c, i) => ({ fingerprint: c.fingerprint, label: fmtFor(io.lang, i === 0 ? 'ssh_edit_offline_known_hosts_entry_recommended' : 'ssh_edit_offline_known_hosts_entry', c.keyType, c.fingerprint) }));
    const optPaste = tFor(io.lang, 'ssh_edit_offline_paste');
    const optLeave = tFor(io.lang, 'ssh_edit_offline_no_pin');
    const optExit = tFor(io.lang, 'ssh_edit_offline_exit');
    const options = [...proposals.map((p) => p.label), optPaste, optLeave, optExit];

    const choice = await io.choose(fmtFor(io.lang, 'ssh_edit_offline_menu', `${host}:${port}`), options);
    const chosen = proposals.find((p) => p.label === choice);
    if (chosen) return chosen.fingerprint;
    switch (choice) {
      case optPaste:
        return this.promptFingerprint(io);
      case optLeave:
        io.warn(tFor(io.lang, 'ssh_edit_no_pin_warn'));
        return '';
      default:
        // optExit or any unexpected selection → cancel the edit (fail-closed).
        throw new HostKeyDeclinedError(tFor(io.lang, 'ssh_edit_cancelled'));
    }
  }

  /**
   * Prompts for an operator-pasted host-key fingerprint, re-prompting on a
   * malformed value. Empty input (the operator pressed Enter, or stdin is closed)
   * abandons the paste and cancels the edit — so a closed/EOF stream can never
   * spin the loop forever.
   * @throws HostKeyDeclinedError on empty input
   */
  private async promptFingerprint(io: ProviderIO): Promise<string> {
    for (;;) {
      const entered = (await io.ask(tFor(io.lang, 'ssh_edit_paste_prompt'))).trim();
      if (entered.length === 0) throw new HostKeyDeclinedError(tFor(io.lang, 'ssh_edit_cancelled'));
      if (isValidFingerprint(entered)) return entered;
      io.warn(tFor(io.lang, 'ssh_edit_fingerprint_invalid'));
    }
  }

  /**
   * Collects the non-revoked `~/.ssh/known_hosts` keys for `host` as
   * `{ keyType, fingerprint }`, deduplicated by fingerprint. A key blob marked
   * `@revoked` anywhere for the host is excluded.
   */
  private async knownHostsCandidates(host: string, port: number): Promise<Array<{ keyType: string; fingerprint: string }>> {
    const entries = await this.matchingKnownHostsEntries(host, port);
    const revokedBlobs = new Set(entries.filter((e) => e.revoked).map((e) => e.keyB64));
    const out: Array<{ keyType: string; fingerprint: string }> = [];
    const seen = new Set<string>();
    for (const e of entries) {
      if (e.revoked || revokedBlobs.has(e.keyB64)) continue;
      const fingerprint = sshFingerprint(Buffer.from(e.keyB64, 'base64'));
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      out.push({ keyType: e.keyType, fingerprint });
    }
    return out;
  }

  /**
   * Builds a config object from the BFS CLI pass-through input. Accepts
   * `--config-file <path>` (JSON) plus inline flags that override it:
   * `--host --port --user --password --private-key --passphrase --path
   * --known-host <fingerprint> --accept-new-host-key`. Auth is password XOR key;
   * with neither, a default key is discovered under `~/.ssh` (id_ed25519, then
   * id_rsa). The remote path must start with `/`.
   *
   * In non-interactive mode `--accept-new-host-key` without an explicit
   * `--known-host` pin realizes true TOFU: it connects once to capture the host
   * key and pins its fingerprint, so every later connection is verified against
   * it. Without the capture the opt-in would trust any key presented on every
   * connection with no prompt — a standing MITM window. Interactive callers are
   * left to the per-connect confirm prompt (they already see the fingerprint).
   *
   * @throws ProviderError on unreadable/malformed config-file, invalid port,
   *   conflicting auth, missing host/path/auth, a non-absolute path, or a
   *   declined/unreachable host key when capturing for `--accept-new-host-key`
   */
  async configureFromFlags(input: CliProviderInput): Promise<Record<string, unknown>> {
    const config: Record<string, unknown> = { port: DEFAULT_SSH_PORT };

    const cfgFile = findStringFlag(input.rawArgs, '--config-file');
    if (cfgFile !== null && cfgFile.length > 0) {
      const absolutePath = path.isAbsolute(cfgFile) ? cfgFile : path.resolve(this.io.workDir, cfgFile);
      const obj = await readJsonObjectFile(absolutePath, 'SSH adapter');
      if (typeof obj.host === 'string') config.host = obj.host;
      if (obj.port !== undefined) {
        const port = typeof obj.port === 'number' ? obj.port : Number(obj.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new ProviderError(tFor(this.io.lang, 'ssh_config_port_invalid'));
        }
        config.port = port;
      }
      if (typeof obj.user === 'string') config.user = obj.user;
      if (typeof obj.password === 'string') config.password = obj.password;
      if (typeof obj.passphrase === 'string') config.passphrase = obj.passphrase;
      if (typeof obj.private_key_path === 'string') config.private_key_path = obj.private_key_path;
      if (typeof obj.path === 'string') config.path = obj.path;
      if (typeof obj.host_key_fingerprint === 'string') config.host_key_fingerprint = obj.host_key_fingerprint;
    }

    const inlineHost = findStringFlag(input.rawArgs, '--host');
    if (inlineHost !== null) config.host = inlineHost;

    const inlinePort = findStringFlag(input.rawArgs, '--port');
    if (inlinePort !== null) {
      const port = Number(inlinePort);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ProviderError(tFor(this.io.lang, 'ssh_inline_port_invalid'));
      }
      config.port = port;
    }

    const inlineUser = findStringFlag(input.rawArgs, '--user');
    if (inlineUser !== null) config.user = inlineUser;

    const inlinePassword = findStringFlag(input.rawArgs, '--password');
    if (inlinePassword !== null) config.password = inlinePassword;

    const inlineKey = findStringFlag(input.rawArgs, '--private-key');
    if (inlineKey !== null) config.private_key_path = inlineKey;

    const inlinePassphrase = findStringFlag(input.rawArgs, '--passphrase');
    if (inlinePassphrase !== null) config.passphrase = inlinePassphrase;

    const inlinePath = findStringFlag(input.rawArgs, '--path');
    if (inlinePath !== null) config.path = inlinePath;

    const inlineKnownHost = findStringFlag(input.rawArgs, '--known-host');
    if (inlineKnownHost !== null) config.host_key_fingerprint = inlineKnownHost;

    if (input.rawArgs.includes('--accept-new-host-key')) {
      // Accepting a new host key means dialing the server to capture and pin it
      // (TOFU). An offline edit never contacts the medium, so it cannot complete
      // this — refuse and point the operator at the offline-capable pin flag
      // (--known-host <SHA256:…>) rather than persist a null pin with accept-new
      // armed (which would trust any key on the next connection).
      if (input.offline === true) {
        throw new ProviderError(tFor(this.io.lang, 'ssh_accept_new_offline'));
      }
      config.accept_new_host_key = true;
    }

    const hasPassword = typeof config.password === 'string' && (config.password as string).length > 0;
    const hasKey = typeof config.private_key_path === 'string' && (config.private_key_path as string).length > 0;
    if (hasPassword && hasKey) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_auth_conflict'));
    }

    if (typeof config.host !== 'string' || config.host.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_host_required'));
    }
    if (typeof config.path !== 'string' || config.path.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_path_required'));
    }
    if (!(config.path as string).startsWith('/')) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_path_must_be_absolute'));
    }

    if (hasPassword) {
      config.auth_method = 'password';
    } else if (hasKey) {
      config.auth_method = 'key';
    } else {
      const defaultKey = await this.findDefaultKey();
      if (defaultKey === null) {
        throw new ProviderError(tFor(this.io.lang, 'ssh_auth_missing'));
      }
      config.private_key_path = defaultKey;
      config.auth_method = 'key';
    }

    // --accept-new-host-key is a first-contact opt-in: capture the presented key
    // now and pin it, so the pinned-fingerprint path (fp === pin) guards every
    // later connection. An explicit --known-host pin is authoritative and left
    // untouched. Only the non-interactive path is captured: that is where the
    // "trust any key every time" window lives (decideHostKeyTrust returns the
    // opt-in without a prompt). Interactive callers already see the fingerprint
    // via the confirm prompt on every connect, so capturing there would only add
    // an unexpected prompt (e.g. mid-recovery when a bootstrap spec carries the
    // flag) without closing a silent window.
    if (this.io.interactive === false && input.rawArgs.includes('--accept-new-host-key') && typeof config.host_key_fingerprint !== 'string') {
      const host = config.host as string;
      const port = config.port as number;
      const user = typeof config.user === 'string' ? config.user : '';
      config.host_key_fingerprint = await this.captureHostKey(this.io, host, port, user, true);
    }

    return config;
  }

  /** Discovers a default private key under ~/.ssh (id_ed25519 preferred, then id_rsa). */
  private async findDefaultKey(): Promise<Nullable<string>> {
    const sshDir = path.join(os.homedir(), '.ssh');
    for (const name of ['id_ed25519', 'id_rsa']) {
      const candidate = path.join(sshDir, name);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // not present — try the next candidate
      }
    }
    return null;
  }

  /**
   * Validates a persisted SSH config. Returns an array of human-readable error
   * messages; empty array means valid. Does not consult ~/.ssh — default-key
   * discovery is an async concern of configureFromFlags.
   */
  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const lang = this.io.lang;

    const host = config.host;
    if (typeof host !== 'string' || host.length === 0) {
      errors.push(tFor(lang, 'ssh_validate_host_required'));
    }

    const port = config.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(tFor(lang, 'ssh_validate_port_invalid'));
    }

    const remotePath = config.path;
    if (typeof remotePath !== 'string' || remotePath.length === 0) {
      errors.push(tFor(lang, 'ssh_validate_path_required'));
    } else {
      if (!remotePath.startsWith('/')) {
        errors.push(tFor(lang, 'ssh_validate_path_absolute'));
      }
      if (/[\r\n\0]/.test(remotePath)) {
        errors.push(tFor(lang, 'ssh_control_chars'));
      }
    }

    const hasPassword = typeof config.password === 'string' && (config.password as string).length > 0;
    const hasKey = typeof config.private_key_path === 'string' && (config.private_key_path as string).length > 0;
    if (!hasPassword && !hasKey) {
      errors.push(tFor(lang, 'ssh_validate_auth_required'));
    } else if (hasPassword && hasKey) {
      // Auth is password XOR key — reject both, matching configureFromFlags, so a
      // hand-edited config cannot silently validate while authOptions() quietly
      // picks one by auth_method.
      errors.push(tFor(lang, 'ssh_validate_auth_conflict'));
    }

    return errors;
  }

  /**
   * Renders a one-line summary of the SSH config for display. Password and
   * passphrase are masked; the private key PATH is shown (a coordinate, not a
   * secret).
   */
  describeConfig(config: Record<string, unknown>): string {
    const host = typeof config.host === 'string' ? config.host : '';
    const port = typeof config.port === 'number' ? String(config.port) : String(config.port ?? '');
    const user = typeof config.user === 'string' ? config.user : '';
    const remotePath = typeof config.path === 'string' ? config.path : '';
    const authPart =
      config.auth_method === 'key' ? `key=${typeof config.private_key_path === 'string' ? config.private_key_path : ''}${typeof config.passphrase === 'string' && config.passphrase.length > 0 ? ' passphrase=****' : ''}` : 'password=****';
    return fmtFor(this.io.lang, 'ssh_describe_config', host, port, user, remotePath, authPart);
  }

  /**
   * Declares which config fields are secrets. BFS strips these from the shard
   * location map and requests them interactively during disaster recovery.
   */
  getSecretFields(): readonly string[] {
    return ['password', 'passphrase'];
  }

  /**
   * Full read/write/verify round-trip against the remote. Must be called after
   * setVaultName() so the probe file lands in the correct sub-dir.
   * @throws ProviderError on any step failure
   */
  async probeConnection(): Promise<void> {
    if (this.host.length === 0 || this.basePath.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'ssh_probe_incomplete'));
    }
    const lang = this.io.lang;
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const probeName = `__bfs_probe_${nonce}.tmp`;
    const probeData = Buffer.from(`bfs-probe-${nonce}`);
    const vaultDir = this.vaultPath();
    const remotePath = `${vaultDir}/${probeName}`;

    await this.withClient(async (sftp) => {
      try {
        await this.ensureDir(sftp, vaultDir);
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ssh_probe_step_ensure_dir', err instanceof Error ? err.message : String(err)));
      }

      try {
        await pipeToWriteStream(bufferToChunkedStream(probeData), sftp.createWriteStream(remotePath));
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ssh_probe_step_upload', err instanceof Error ? err.message : String(err)));
      }

      let downloaded: Buffer;
      try {
        downloaded = await downloadToBuffer(sftp, remotePath);
      } catch (err) {
        await this.bestEffortUnlink(sftp, remotePath);
        throw new ProviderError(fmtFor(lang, 'ssh_probe_step_download', err instanceof Error ? err.message : String(err)));
      }

      if (Buffer.compare(probeData, downloaded) !== 0) {
        await this.bestEffortUnlink(sftp, remotePath);
        throw new ProviderError(tFor(lang, 'ssh_probe_step_compare_remote'));
      }

      try {
        await unlinkAsync(sftp, remotePath);
      } catch (err) {
        throw new ProviderError(fmtFor(lang, 'ssh_probe_step_cleanup', err instanceof Error ? err.message : String(err)));
      }
    });
  }
}

// ─── Factory + registry ──────────────────────────────────────────────────────

const sshFactory: ProviderFactory = {
  lang: 'en',
  displayName: 'SSH/SFTP',
  requiresApiVersion: 2,
  create: (config, io) => new SshProvider(config, io),
  help(): ProviderHelp {
    return {
      usage: '[--host <h>] [--port <n>] [--user <u>] [--password <p>] [--private-key <path>] ' + '[--passphrase <p>] [--path <p>] [--known-host <fp>] [--accept-new-host-key] [--config-file <path>]',
      description: tFor(this.lang, 'ssh_help_description'),
      flags: [
        { flag: '--host <host>', description: tFor(this.lang, 'ssh_help_flag_host_desc') },
        { flag: '--port <port>', description: tFor(this.lang, 'ssh_help_flag_port_desc') },
        { flag: '--user <user>', description: tFor(this.lang, 'ssh_help_flag_user_desc') },
        { flag: '--password <password>', description: tFor(this.lang, 'ssh_help_flag_password_desc') },
        { flag: '--private-key <path>', description: tFor(this.lang, 'ssh_help_flag_private_key_desc') },
        { flag: '--passphrase <passphrase>', description: tFor(this.lang, 'ssh_help_flag_passphrase_desc') },
        { flag: '--path <path>', description: tFor(this.lang, 'ssh_help_flag_path_desc') },
        { flag: '--known-host <fingerprint>', description: tFor(this.lang, 'ssh_help_flag_known_host_desc') },
        { flag: '--accept-new-host-key', description: tFor(this.lang, 'ssh_help_flag_accept_new_host_key_desc') },
        { flag: '--config-file <path>', description: tFor(this.lang, 'ssh_help_flag_config_file_desc') },
      ],
      examples: [
        'bfs provider add --ci --name nas --type ssh \\',
        '  --host ssh.example.com --port 22 --user backup \\',
        "  --private-key ~/.ssh/id_ed25519 --path /backup --known-host 'SHA256:…'",
        '',
        'bfs provider add --ci --name nas --type ssh --config-file ./nas.json',
        '# nas.json:',
        '# {',
        '#   "host": "ssh.example.com",',
        '#   "port": 22,',
        '#   "user": "backup",',
        '#   "private_key_path": "/home/backup/.ssh/id_ed25519",',
        '#   "path": "/backup",',
        '#   "host_key_fingerprint": "SHA256:…"',
        '# }',
      ],
    };
  },
};

providerRegistry.register('ssh', sshFactory);
