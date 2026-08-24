import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import * as ftp from 'basic-ftp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, TamperDetectedError } from '../../src/core/errors.js';
import { tFor } from '../../src/i18n/index.js';
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, StorageProvider } from '../../src/types/index.js';

// --- Real-TLS integration proof for FTPS certificate pinning -----------------
//
// This suite is DELIBERATELY unmocked: it uses the real `basic-ftp` client
// against a real `tls.TLSSocket`, so it exercises the exact runtime path the
// provider will take (connect -> useTLS -> read peer certificate -> compare pin ->
// login). A mock of `getPeerCertificate` would prove nothing - the whole point
// is that the provider reads a genuinely-presented certificate over a live TLS
// handshake - real IO, not just a mock.
//
// The binding property is "verify-before-login": with `secure:true` the PASS
// command (which carries the password) must be sent only AFTER the peer
// certificate's fingerprint is confirmed against the configured pin. The test
// server records whether PASS ever arrived, so a pinning failure that still
// leaked the password would be caught.
//
// RED (current code has no pinning): the provider connects via
// `client.access({ secure:true })`, whose default `rejectUnauthorized:true`
// rejects the self-signed fixture certificate at the TLS layer - the operation
// fails with a certificate-validation error (e.g. DEPTH_ZERO_SELF_SIGNED_CERT)
// wrapped in ProviderError, NOT a TamperDetectedError, and never controls
// whether PASS was reached. Assertions target error TYPES and the
// `passReceived` flag, never translated strings (the i18n keys this feature
// needs do not exist yet).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures', 'ftp-tls');
const CERT_PEM = readFileSync(path.join(FIXTURE_DIR, 'cert.pem'));
const KEY_PEM = readFileSync(path.join(FIXTURE_DIR, 'key.pem'));

/** Uppercase colon-hex SHA-256 of the fixture cert's DER - the "known pin". */
const KNOWN_PIN = new X509Certificate(CERT_PEM).fingerprint256;

/**
 * Returns a well-formed but different colon-hex fingerprint by flipping the
 * first octet - a valid pin that does not match the fixture certificate.
 */
function flipFirstOctet(pin: string): string {
  const parts = pin.split(':');
  const first = Number.parseInt(parts[0], 16);
  parts[0] = ((first ^ 0xff) & 0xff).toString(16).toUpperCase().padStart(2, '0');
  return parts.join(':');
}

const WRONG_PIN = flipFirstOctet(KNOWN_PIN);

/** Shared state a test asserts against after driving the provider. */
interface ServerState {
  passReceived: boolean;
  /** True once the server-side TLS handshake completed (the `secure` event). */
  tlsEstablished: boolean;
}

/** Handle to a running in-process FTPS test server. */
interface TlsFtpServerHandle {
  readonly port: number;
  readonly state: ServerState;
  close(): Promise<void>;
}

/**
 * Splits a byte stream into CRLF/LF-terminated ASCII lines, invoking `onLine`
 * for each. Returns a detach function that removes the listener (used to stop
 * reading the plaintext socket the instant it is upgraded to TLS).
 */
function attachLineReader(stream: Duplex, onLine: (line: string) => void): () => void {
  let buffer = Buffer.alloc(0);
  const handler = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const idx = buffer.indexOf(0x0a);
      if (idx === -1) break;
      let line = buffer.subarray(0, idx);
      buffer = buffer.subarray(idx + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      onLine(line.toString('ascii'));
    }
  };
  stream.on('data', handler);
  return () => {
    stream.removeListener('data', handler);
  };
}

/**
 * Answers the post-TLS FTP command sequence a real basic-ftp login drives
 * (login + useDefaultSettings + SIZE). PASS flips `state.passReceived` so a test
 * can prove the password was (or was not) sent. FEAT advertises no MLST so the
 * client uses plain listing and skips OPTS MLST.
 */
function respondPhase2(stream: Duplex, line: string, state: ServerState): void {
  const verb = line.split(' ')[0].toUpperCase();
  switch (verb) {
    case 'USER':
      stream.write('331 Need password\r\n');
      break;
    case 'PASS':
      state.passReceived = true;
      stream.write('230 Login successful\r\n');
      break;
    case 'FEAT':
      stream.write('211-Features:\r\n UTF8\r\n211 End\r\n');
      break;
    case 'SIZE':
      stream.write('213 1024\r\n');
      break;
    case 'PWD':
      stream.write('257 "/" is the current directory\r\n');
      break;
    case 'CWD':
      stream.write('250 OK\r\n');
      break;
    case 'QUIT':
      stream.write('221 Goodbye\r\n');
      stream.end();
      break;
    default:
      // TYPE, STRU, OPTS, PBSZ, PROT and anything else -> generic success.
      stream.write('200 OK\r\n');
  }
}

/**
 * Starts a minimal in-process FTP server on a random loopback port that speaks
 * plaintext until AUTH TLS, then upgrades the very same socket to a real
 * `tls.TLSSocket` presenting the fixture certificate. Tracks whether PASS was
 * received. Cross-platform (loopback, port 0) and self-tearing-down.
 */
function startTlsFtpServer(): Promise<TlsFtpServerHandle> {
  const state: ServerState = { passReceived: false, tlsEstablished: false };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // A client that rejects the self-signed cert (current code path) aborts the
    // handshake - the resulting socket error is expected, swallow it.
    socket.on('error', () => {});

    const detachPlain = attachLineReader(socket, (line) => {
      if (line.toUpperCase().startsWith('AUTH')) {
        socket.write('234 Proceed with TLS\r\n');
        // Stop reading plaintext BEFORE wrapping, so the TLSSocket alone
        // consumes the raw bytes (the ClientHello arrives after the client
        // reads our 234, i.e. after this synchronous handler returns).
        detachPlain();
        const tlsSocket = new tls.TLSSocket(socket, { isServer: true, key: KEY_PEM, cert: CERT_PEM });
        // Fires only when the handshake COMPLETES - i.e. the client accepted the
        // certificate (rejectUnauthorized:false). A client that rejects the cert
        // (rejectUnauthorized:true) aborts before this, leaving tlsEstablished false.
        tlsSocket.on('secure', () => {
          state.tlsEstablished = true;
        });
        tlsSocket.on('error', () => {});
        attachLineReader(tlsSocket, (l) => respondPhase2(tlsSocket, l, state));
      } else {
        socket.write('530 AUTH TLS required\r\n');
      }
    });
    socket.write('220 BFS test FTPS server\r\n');
  });
  server.on('error', () => {});

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        state,
        close(): Promise<void> {
          for (const s of sockets) s.destroy();
          sockets.clear();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

/**
 * Builds an FtpProvider config pointed at the test server. `secure` defaults to
 * true here; `extra` supplies the pinning knobs under test (cert_fingerprint,
 * accept_new_cert).
 */
function makeFtpConfig(port: number, extra: Record<string, unknown>): ProviderConfig {
  return { id: 'ftps-pin', type: 'ftp', adapterPackage: null, config: { host: '127.0.0.1', port, user: 'victim', password: 'super-secret-pw', path: '/backup', secure: true, ...extra } };
}

const SHARD_REF = { provider_id: 'ftps-pin', path: 'shard_0.bfs.1' };

/**
 * Mock ProviderIO driving `configureInteractive` at the test server: the
 * host/port/user/password/path prompts are answered by their exact EN strings,
 * the FTPS-enable confirm returns true, and any LATER confirm (the cert-trust
 * prompt the GREEN TOFU-capture adds) returns `trustCert`. The two confirms are
 * distinguished by message so the mock does not depend on call order.
 */
function captureIo(port: number, trustCert: boolean): ProviderIO {
  const { io } = createMockProviderIO({ 'FTP host:': '127.0.0.1', 'Port (default 21):': String(port), 'Username:': 'victim', 'Password:': 'super-secret-pw', 'Base path on server:': '/backup', 'Use FTPS (secure connection)?': 'true' });
  return {
    ...io,
    async confirm(message: string): Promise<boolean> {
      if (message === 'Use FTPS (secure connection)?') return true;
      return trustCert;
    },
    async choose(_message: string, options: string[]): Promise<string> {
      // The identity decision is a menu here too: take the accept or the cancel
      // exit, never the way back - that has its own tests.
      const wanted = trustCert ? TRUST_KEYWORD.accept : TRUST_KEYWORD.cancel;
      return options.find((o) => wanted.test(o)) ?? options[0] ?? '';
    },
  };
}

/** A well-formed pin distinct from both KNOWN_PIN and WRONG_PIN - stands for a
 * fingerprint the operator reads off a second channel and types in by hand. */
const PASTED_PIN = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';

/**
 * Binds `count` loopback ports at once, then releases them all, returning the
 * numbers - addresses where a connection is refused immediately, i.e. media that
 * are genuinely down. Binding them simultaneously is what guarantees they differ:
 * allocating one at a time can hand out the same number twice, and a test whose
 * "dead" and "stored" ports collide silently takes the reuse branch and fails for
 * a reason that looks like a regression.
 */
async function reservedFreePorts(count: number): Promise<number[]> {
  const probes = Array.from({ length: count }, () => net.createServer());
  await Promise.all(probes.map((p) => new Promise<void>((resolve) => p.listen(0, '127.0.0.1', () => resolve()))));
  const ports = probes.map((p) => {
    const addr = p.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  });
  await Promise.all(probes.map((p) => new Promise<void>((resolve) => p.close(() => resolve()))));
  return ports;
}

/** One loopback address where a connection is refused immediately. */
async function reservedFreePort(): Promise<number> {
  const [port] = await reservedFreePorts(1);
  return port;
}

/** Keywords identifying each exit of the identity-trust decision, so a test picks
 * an option by meaning rather than by wording. */
const TRUST_KEYWORD = { accept: /trust|zaufaj/i, back: /back|wr[oó][cć]|cofnij/i, cancel: /cancel|anuluj/i } as const;

/** True when this menu is the certificate-trust decision: it quotes the
 * fingerprint the server presented and offers a way to accept it. */
function isTrustMenu(message: string, options: string[]): boolean {
  return /([0-9A-F]{2}:){8}/i.test(message) && options.some((o) => TRUST_KEYWORD.accept.test(o));
}

/** One recorded ProviderIO interaction, so a test can assert what the operator
 * was (or was not) shown. */
interface EditCall {
  kind: 'ask' | 'askSecret' | 'confirm' | 'choose' | 'warn';
  text: string;
  options?: string[];
}

/**
 * ProviderIO driving `configureInteractiveForEdit`: answers the field prompts
 * with the values the operator is typing for the NEW config, routes the
 * FTPS-enable confirm to true and any later (certificate-trust) confirm to
 * `trustCert`, and answers a fingerprint-paste prompt with PASTED_PIN.
 *
 * `choose` picks an option by keyword rather than by exact label, so the test
 * does not hard-code the wording of the offline menu.
 */
function editIo(opts: { host: string; port: number; password: string; secure?: boolean; pick?: RegExp; pasteReplies?: string[]; trust?: 'accept' | 'back' | 'cancel'; rounds?: Array<{ host?: string; port?: number; password?: string }> }): {
  io: ProviderIO;
  calls: EditCall[];
} {
  const calls: EditCall[] = [];
  const pasteReplies = opts.pasteReplies ?? [PASTED_PIN];
  let pasted = 0;
  // The host prompt opens every pass over the connection fields, so it doubles as
  // the round counter: a flow that goes back asks it again.
  let round = -1;
  const forRound = (): { host?: string; port?: number; password?: string } => {
    const rounds = opts.rounds;
    if (rounds === undefined || rounds.length === 0) return {};
    return rounds[Math.min(Math.max(round, 0), rounds.length - 1)];
  };
  const { io: base } = createMockProviderIO();
  const io: ProviderIO = {
    ...base,
    async ask(prompt: string): Promise<string> {
      calls.push({ kind: 'ask', text: prompt });
      if (/fingerprint|sha-?256|odcisk/i.test(prompt)) {
        const reply = pasteReplies[Math.min(pasted, pasteReplies.length - 1)];
        pasted += 1;
        return reply;
      }
      if (prompt === 'FTP host:') {
        round += 1;
        return forRound().host ?? opts.host;
      }
      if (prompt === 'Port (default 21):') return String(forRound().port ?? opts.port);
      if (prompt === 'Username:') return 'victim';
      if (prompt === 'Base path on server:') return '/backup';
      return '';
    },
    async askSecret(prompt: string): Promise<string> {
      calls.push({ kind: 'askSecret', text: prompt });
      return forRound().password ?? opts.password;
    },
    async confirm(message: string): Promise<boolean> {
      calls.push({ kind: 'confirm', text: message });
      if (message === 'Use FTPS (secure connection)?') return opts.secure !== false;
      // The identity decision is a menu, so nothing else on this path may be a
      // yes/no question. Throwing here makes a flow that still asks one say so,
      // instead of surfacing as a generic "certificate was not trusted".
      throw new Error(`the certificate decision must be a menu, not a yes/no confirm: ${message}`);
    },
    async choose(message: string, options: string[]): Promise<string> {
      calls.push({ kind: 'choose', text: message, options });
      // Two different menus can appear in one edit. The trust decision is the one
      // that quotes a fingerprint; anything else is the offline menu. Options are
      // matched by keyword so the test does not hard-code either wording.
      if (isTrustMenu(message, options)) {
        const wanted = TRUST_KEYWORD[opts.trust ?? 'accept'];
        return options.find((o) => wanted.test(o)) ?? options[0] ?? '';
      }
      const picked = opts.pick ? options.find((o) => opts.pick?.test(o)) : undefined;
      return picked ?? options[0] ?? '';
    },
    warn(message: string): void {
      calls.push({ kind: 'warn', text: message });
    },
  };
  return { io, calls };
}

/** The stored config an edit starts from: a pinned FTPS provider. */
function existingFtpsConfig(port: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { host: '127.0.0.1', port, user: 'victim', password: 'old-password', path: '/backup', secure: true, cert_fingerprint: WRONG_PIN, cert_self_signed: true, ...overrides };
}

// --- `bfs provider edit` on FTPS - the pin is the gate, not the prompt --------
//
// SECURITY.md ("Transport to a provider") promises that a server presenting an
// identity OTHER than the pinned one is refused rather than adopted. The
// certificate decision is also what protects the password, because it runs
// before login. An edit therefore must not be the one path where the stored pin
// is replaced by whatever answers at the address.
//
// The stored pin in these tests is WRONG_PIN - deliberately NOT the certificate
// the test server presents. Any flow that goes to the medium and TOFU-captures
// what it finds ends up with KNOWN_PIN, which is exactly the silent re-pin under
// test; a flow that reuses what was stored keeps WRONG_PIN.
//
// The second property is the offline-completion guarantee: an edit exists
// precisely because the medium is unreachable, so it has to end with a written
// config even then.
describe('FtpProvider - configureInteractiveForEdit keeps the stored pin and completes offline', () => {
  let server: TlsFtpServerHandle;

  beforeEach(async () => {
    server = await startTlsFtpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('reuses the stored certificate pin without contacting the medium when host and port are unchanged', async () => {
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'rotated-password' });
    // Typed as the contract, not the class: `configureInteractiveForEdit` is the
    // optional API-v2 hook, so the assertion below is about what this adapter
    // implements at runtime rather than about what compiles.
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    expect(result?.cert_fingerprint).toBe(WRONG_PIN);
    expect(result?.cert_self_signed).toBe(true);
    expect(result?.password).toBe('rotated-password');
    // No handshake at all: the reuse path never dials, so the certificate the
    // server would present cannot enter the config.
    expect(server.state.tlsEstablished).toBe(false);
    // Not "no yes/no confirm about the certificate": after the fix no such
    // confirm exists anywhere, so that assertion would guard nothing. What has to
    // stay true is that the reuse branch asks the operator NOTHING at all.
    expect(calls.some((c) => c.kind === 'choose')).toBe(false);
  }, 20000);

  it('completes the edit offline when the new address is unreachable, pinning the fingerprint the operator supplies', async () => {
    const deadPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: deadPort, password: 'pw', pick: /paste|wklej/i });
    // Typed as the contract, not the class: `configureInteractiveForEdit` is the
    // optional API-v2 hook, so the assertion below is about what this adapter
    // implements at runtime rather than about what compiles.
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    // Old identity is the live server; the operator is moving the provider to an
    // address that is down - the case the command exists for.
    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    expect(result?.port).toBe(deadPort);
    expect(result?.cert_fingerprint).toBe(PASTED_PIN);
    expect(calls.some((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3)).toBe(true);
  }, 20000);

  it('pins the certificate presented at a reachable new address once the operator accepts it', async () => {
    const oldPort = await reservedFreePort();
    const { io } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', trust: 'accept' });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    // Moving to a different address IS a change of server identity, so the pin
    // has to be re-established - reuse would leave the config pinned to a server
    // it will never talk to again.
    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) });

    expect(result?.cert_fingerprint).toBe(KNOWN_PIN);
    expect(result?.cert_self_signed).toBe(true);
    // The capture closes its throwaway client the moment it holds the
    // certificate, so under TLS 1.3 the server's handshake-complete signal can
    // land a tick later. Settle before reading it; the pin above already proves
    // the fingerprint came off the wire.
    await new Promise((r) => setTimeout(r, 30));
    expect(server.state.tlsEstablished).toBe(true);
  }, 20000);

  it('drops the stored pin when the operator turns FTPS off, leaving a config that validates', async () => {
    const { io } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', secure: false });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    // A pin without TLS is rejected by validateConfig, so carrying the old one
    // over would turn a legitimate downgrade into an unfixable config.
    expect(result?.secure).toBe(false);
    expect(result?.cert_fingerprint).toBeUndefined();
    expect(provider.validateConfig(result ?? {})).toEqual([]);
  }, 20000);

  it('re-asks with a prompt-shaped warning when the pasted fingerprint is malformed', async () => {
    const deadPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: deadPort, password: 'pw', pick: /paste|wklej/i, pasteReplies: ['not-a-fingerprint', PASTED_PIN] });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    expect(result?.cert_fingerprint).toBe(PASTED_PIN);
    expect(calls.filter((c) => c.kind === 'ask' && /fingerprint/i.test(c.text)).length).toBeGreaterThanOrEqual(2);
    // The warning belongs to the prompt, not to the `--cert-fingerprint` flag the
    // operator never typed, and it has to say the question comes back.
    expect(calls.some((c) => c.kind === 'warn' && c.text === tFor('en', 'ftp_edit_fingerprint_invalid'))).toBe(true);
  }, 20000);

  it('clears the pin when the operator chooses to save without one at an unreachable new address', async () => {
    const deadPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: deadPort, password: 'pw', pick: /without|no pin|bez/i });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    // Carrying the OLD pin to a NEW address would make every later connection
    // fail as tamper, with no way out short of editing again.
    expect(result?.cert_fingerprint).toBeUndefined();
    expect(calls.some((c) => c.kind === 'warn')).toBe(true);
  }, 20000);

  it('aborts instead of falling back to the offline menu when the operator cancels at the certificate decision', async () => {
    const oldPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', trust: 'cancel' });
    // Typed as the contract, not the class: `configureInteractiveForEdit` is the
    // optional API-v2 hook, so the assertion below is about what this adapter
    // implements at runtime rather than about what compiles.
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
    expect(typeof provider.configureInteractiveForEdit).toBe('function');

    // Identity changed to a REACHABLE address and the operator cancels: that is a
    // decision, not an outage, so it must not be softened into the offline menu.
    await expect(provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) })).rejects.toThrow(ProviderError);
    expect(calls.some((c) => c.kind === 'choose' && isTrustMenu(c.text, c.options ?? []))).toBe(true);
    expect(calls.some((c) => c.kind === 'choose' && (c.options ?? []).some((o) => /paste|wklej/i.test(o)))).toBe(false);
  }, 20000);

  // --- Three exits from the identity decision -------------------------------
  //
  // Refusing a certificate usually does not mean "I distrust this server" - it
  // means "I aimed at the wrong one, and I only noticed now, at this question".
  // A yes/no decision makes that mistake cost every field already entered:
  // address, user, password, path. So the decision gains a way back.

  it('offers three exits at the certificate decision, quoting the presented fingerprint', async () => {
    const oldPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', trust: 'accept' });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) });

    const decision = calls.find((c) => c.kind === 'choose' && c.text.includes(KNOWN_PIN));
    expect(decision).toBeDefined();
    expect(decision?.options).toHaveLength(3);
  }, 20000);

  it('returns to the connection prompts when the operator goes back, keeping what they type on the second pass', async () => {
    const oldPort = await reservedFreePort();
    let trustMenus = 0;
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'first-pass-password', rounds: [{ password: 'first-pass-password' }, { password: 'corrected-password' }] });
    // Go back once, then accept - an IO that always goes back could never finish,
    // and that case is pinned by its own test below.
    const backThenAccept: ProviderIO = {
      ...io,
      async choose(message: string, options: string[]): Promise<string> {
        await io.choose(message, options);
        if (!isTrustMenu(message, options)) return options[0] ?? '';
        trustMenus += 1;
        const wanted = trustMenus === 1 ? TRUST_KEYWORD.back : TRUST_KEYWORD.accept;
        return options.find((o) => wanted.test(o)) ?? options[0] ?? '';
      },
    };
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, backThenAccept);

    const result = await provider.configureInteractiveForEdit?.(backThenAccept, { existingConfig: existingFtpsConfig(oldPort) });

    expect(calls.filter((c) => c.kind === 'ask' && c.text === 'FTP host:')).toHaveLength(2);
    expect(result?.password).toBe('corrected-password');
    expect(result?.cert_fingerprint).toBe(KNOWN_PIN);
  }, 20000);

  it('stops re-asking once the operator has gone back too many times', async () => {
    const oldPort = await reservedFreePort();
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', trust: 'back' });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    // An IO that always goes back has to terminate: a closed stream or a mock
    // would otherwise spin here forever. Three restarts means the fields are
    // collected four times in total, and then the edit gives up.
    await expect(provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) })).rejects.toThrow(ProviderError);
    expect(calls.filter((c) => c.kind === 'ask' && c.text === 'FTP host:')).toHaveLength(4);
  }, 20000);

  it('returns to the connection prompts when the operator goes back from the offline menu', async () => {
    const [deadPort, oldPort] = await reservedFreePorts(2);
    const { io, calls } = editIo({ host: '127.0.0.1', port: deadPort, password: 'pw', pick: TRUST_KEYWORD.back, trust: 'accept', rounds: [{ port: deadPort }, { port: server.port }] });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    // A typo in the address lands here far more often than at the certificate
    // decision, so this menu needs the same way back.
    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) });

    expect(calls.filter((c) => c.kind === 'ask' && c.text === 'FTP host:')).toHaveLength(2);
    expect(result?.port).toBe(server.port);
    expect(result?.cert_fingerprint).toBe(KNOWN_PIN);
  }, 20000);

  it('stops re-asking once the operator has gone back too many times from the offline menu', async () => {
    const [deadPort, oldPort] = await reservedFreePorts(2);
    const { io, calls } = editIo({ host: '127.0.0.1', port: deadPort, password: 'pw', pick: TRUST_KEYWORD.back });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    // The same budget has to bound both menus - otherwise one of them terminates
    // and the other spins, which is the kind of asymmetry nobody finds until it
    // hangs someone's terminal.
    await expect(provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) })).rejects.toThrow(ProviderError);
    expect(calls.filter((c) => c.kind === 'ask' && c.text === 'FTP host:')).toHaveLength(4);
  }, 20000);

  it('does not pin a certificate read during a round the operator walked away from', async () => {
    const [deadPort, oldPort] = await reservedFreePorts(2);
    // Round 1 reaches the live server and reads its certificate; the operator
    // goes back. Round 2 aims somewhere unreachable and saves without a pin.
    const { io } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', trust: 'back', pick: /without|no pin|bez/i, rounds: [{ port: server.port }, { port: deadPort }] });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(oldPort) });

    // A certificate belonging to an address the operator abandoned must not end
    // up trusted for the address they actually saved - that is the whole defect
    // this iteration exists to close, reappearing through the back door.
    expect(result?.port).toBe(deadPort);
    expect(result?.cert_fingerprint).toBeUndefined();
  }, 20000);

  it('says that the pinned certificate will be removed when the operator turns FTPS off', async () => {
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', secure: false });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    const result = await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port) });

    expect(result?.cert_fingerprint).toBeUndefined();
    // Losing a pinned identity is permanent and invisible in what the operator
    // sees afterwards, so it has to be said at the moment it happens - and it has
    // to name the fingerprint, otherwise the notice is unverifiable for them.
    expect(calls.some((c) => c.kind === 'warn' && c.text.includes(WRONG_PIN))).toBe(true);
  }, 20000);

  it('says nothing about a certificate when there was no pin to remove', async () => {
    const { io, calls } = editIo({ host: '127.0.0.1', port: server.port, password: 'pw', secure: false });
    const provider: StorageProvider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

    await provider.configureInteractiveForEdit?.(io, { existingConfig: existingFtpsConfig(server.port, { cert_fingerprint: undefined, cert_self_signed: undefined }) });

    // Narrowed to certificate talk rather than to warnings in general, so a later,
    // unrelated notice on this path does not have to fight this assertion.
    expect(calls.some((c) => c.kind === 'warn' && /([0-9A-F]{2}:){8}/i.test(c.text))).toBe(false);
  }, 20000);
});

describe('FtpProvider - FTPS certificate pinning verifies BEFORE login (real TLS socket)', () => {
  let server: TlsFtpServerHandle;

  beforeEach(async () => {
    server = await startTlsFtpServer();
  });

  afterEach(async () => {
    await server.close();
  });

  // Harness sanity (GREEN regardless of the provider): a real basic-ftp client
  // that skips CA validation reads the fixture certificate straight off the live
  // TLS socket, and its fingerprint256 equals the pin the tests below use. Proves
  // any RED below is the provider's missing pinning, not a broken test server.
  it('server presents the fixture certificate over a real TLS handshake', async () => {
    const client = new ftp.Client(10000);
    try {
      await client.connect('127.0.0.1', server.port);
      await client.useTLS({ rejectUnauthorized: false, host: '127.0.0.1' });
      const socket = client.ftp.socket;
      const presented = socket instanceof tls.TLSSocket ? socket.getPeerCertificate(true).fingerprint256 : null;
      expect(presented).toBe(KNOWN_PIN);
    } finally {
      client.close();
    }
  }, 20000);

  // MATCH - the pin equals the presented certificate: the operation completes
  // AND PASS was sent, proving login runs only after a successful pin check.
  it('accepts a matching pin and completes login (PASS sent after verification)', async () => {
    const { io } = createMockProviderIO();
    const provider = new FtpProvider(makeFtpConfig(server.port, { cert_fingerprint: KNOWN_PIN }), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).resolves.toBe(1024);
    expect(server.state.passReceived).toBe(true);
  }, 20000);

  // MISMATCH (the key proof) - a valid but wrong pin: the provider must throw
  // TamperDetectedError from its own fingerprint comparison, and PASS must NEVER
  // be sent. This is the binding "verify-before-login" evidence: the deliberate
  // TamperDetectedError (not a TLS-layer error) proves the provider's pin check
  // gated the password.
  it('rejects a mismatching pin with TamperDetectedError and never sends PASS', async () => {
    const { io } = createMockProviderIO();
    const provider = new FtpProvider(makeFtpConfig(server.port, { cert_fingerprint: WRONG_PIN }), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).rejects.toThrow(TamperDetectedError);
    expect(server.state.passReceived).toBe(false);
  }, 20000);

  // FAIL-CLOSED - no pin, non-interactive, no TOFU opt-in: an unverifiable
  // certificate must be refused, PASS never sent. This is a policy refusal
  // ("cannot establish trust"), NOT a detected tamper, so it surfaces as a plain
  // ProviderError - mirroring SSH's non-interactive host-key behaviour (a boolean
  // trust denial that the transport turns into a generic ProviderError), not the
  // TamperDetectedError reserved for a pin that mismatches a presented cert.
  //
  // The binding RED signal is tlsEstablished===true: the provider must COMPLETE
  // the TLS handshake (rejectUnauthorized:false), read the presented cert, and
  // only THEN refuse by policy. Current code fails the handshake outright
  // (rejectUnauthorized:true on a self-signed cert) -> tlsEstablished stays false.
  // This contract is what lets the TOFU opt-in trust a self-signed cert at all.
  //
  // The IO says yes to every confirm on purpose. Without it the assertion is
  // transparent: drop the non-interactive check and the code falls through to
  // io.confirm, a mock that declines by default answers no, and the refusal
  // still arrives as a ProviderError - from the operator-declined branch, which
  // is a different contract. Consent that would be honoured turns removing the
  // check into a completed login, so the refusal here can only be the policy one.
  it('fails closed for an unpinned cert in non-interactive mode without --accept-new-cert', async () => {
    const { io: base } = createMockProviderIO({}, process.cwd(), false);
    const io: ProviderIO = { ...base, confirm: async () => true };
    const provider = new FtpProvider(makeFtpConfig(server.port, {}), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).rejects.toThrow(ProviderError);
    expect(server.state.passReceived).toBe(false);
    // The provider completes the TLS handshake, reads the cert, and only THEN
    // refuses by policy - destroying the socket immediately. Under TLS 1.3 the
    // client sends its Finished last, so the server's `secure` event can land a
    // tick AFTER the provider has already rejected. Settle briefly so the
    // server-side handshake-complete signal flushes before we assert it: the
    // binding property (handshake reached completion, refusal came from policy,
    // not a TLS-layer rejection) is still what is being verified.
    await new Promise((r) => setTimeout(r, 30));
    expect(server.state.tlsEstablished).toBe(true);
  }, 20000);

  // TOFU opt-in - no pin but accept_new_cert is set (the `--accept-new-cert`
  // flag): the provider trusts the presented certificate and completes login, so
  // PASS is sent.
  it('accepts a new cert under the accept_new_cert opt-in and completes login', async () => {
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const provider = new FtpProvider(makeFtpConfig(server.port, { accept_new_cert: true }), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).resolves.toBe(1024);
    expect(server.state.passReceived).toBe(true);
  }, 20000);

  // THIRD RUNG - no pin, but an operator is present: the decision is theirs, and
  // declining refuses the connection just as firmly. createMockProviderIO answers
  // an unmatched confirm with false, which is exactly a decline. This is the
  // counterpart of the non-interactive refusal above: together they show the
  // refusal can come from policy OR from consent, and that neither sends PASS.
  it('refuses an unpinned cert the operator declines, before sending PASS', async () => {
    const { io } = createMockProviderIO({}, process.cwd(), true);
    const provider = new FtpProvider(makeFtpConfig(server.port, {}), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).rejects.toThrow(ProviderError);
    expect(server.state.passReceived).toBe(false);
  }, 20000);

  // SECOND CALL-SITE - verifyShard connects through readHeaderWindowDirect, which
  // opens its OWN client.access (not the withClient/getSize path). Pinning must
  // cover it too: a mismatching pin must abort after useTLS, BEFORE login, and
  // surface as TamperDetectedError. verifyShard normally swallows connect errors
  // into a structured { ok:false, reason } result, so a detected tamper here must
  // be re-thrown, not classified as `unverifiable`. PASS must never be sent.
  it('rejects a mismatching pin at the verifyShard call-site with TamperDetectedError and never sends PASS', async () => {
    const { io } = createMockProviderIO();
    const provider = new FtpProvider(makeFtpConfig(server.port, { cert_fingerprint: WRONG_PIN }), io);
    provider.setVaultName('vault');

    const expected = { vault_id: '550e8400-e29b-41d4-a716-446655440000', shard_index: 0, version: 1 };
    await expect(provider.verifyShard(SHARD_REF, expected)).rejects.toThrow(TamperDetectedError);
    expect(server.state.passReceived).toBe(false);
  }, 20000);

  // CAPTURE FLOW - configureInteractive TOFU-captures the presented certificate
  // when TLS is enabled. Established prompt order the GREEN capture must follow
  // (createMockProviderIO answers are keyed by these exact EN strings):
  //   1. io.ask('FTP host:')
  //   2. io.ask('Port (default 21):')
  //   3. io.ask('Username:')
  //   4. io.askSecret('Password:')
  //   5. io.ask('Base path on server:')
  //   6. io.confirm('Use FTPS (secure connection)?')   -> if true, capture:
  //   7. connect + useTLS({ rejectUnauthorized:false }) + read peer certificate
  //   8. io.confirm(<cert-trust prompt: fingerprint + self-signed/CA kind>)
  //        accept  -> config gains cert_fingerprint (= presented fingerprint256)
  //                  and cert_self_signed (bool)
  //        decline -> throw (no pin captured)
  // The mock keeps the FTPS-enable confirm true and routes the later cert-trust
  // confirm to `trustCert`.

  it('TOFU-captures the presented cert fingerprint and self-signed marker on accept', async () => {
    const { io: ctorIo } = createMockProviderIO();
    const provider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, ctorIo);

    const config = await provider.configureInteractive(captureIo(server.port, true));

    expect(config.cert_fingerprint).toBe(KNOWN_PIN);
    expect(config.cert_self_signed).toBe(true);
  }, 20000);

  it('throws (captures no pin) when the operator declines the presented cert', async () => {
    const { io: ctorIo } = createMockProviderIO();
    const provider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, ctorIo);

    await expect(provider.configureInteractive(captureIo(server.port, false))).rejects.toThrow(ProviderError);
  }, 20000);

  // Adding a provider gets the same way back as editing one: the mistake it
  // guards against - "I aimed at the wrong server and noticed only at this
  // question" - costs even more here, because `bfs init` collects the backup
  // name, the scheme and every earlier provider before reaching this point.
  it('returns to the connection prompts when the operator goes back while adding a provider', async () => {
    const { io: ctorIo } = createMockProviderIO();
    const provider = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, ctorIo);
    let hostPrompts = 0;
    let menus = 0;
    const base = captureIo(server.port, true);
    const io: ProviderIO = {
      ...base,
      async ask(prompt: string): Promise<string> {
        if (prompt === 'FTP host:') hostPrompts += 1;
        return base.ask(prompt);
      },
      async choose(_message: string, options: string[]): Promise<string> {
        menus += 1;
        const wanted = menus === 1 ? TRUST_KEYWORD.back : TRUST_KEYWORD.accept;
        return options.find((o) => wanted.test(o)) ?? options[0] ?? '';
      },
    };

    const config = await provider.configureInteractive(io);

    expect(hostPrompts).toBe(2);
    expect(config.cert_fingerprint).toBe(KNOWN_PIN);
  }, 20000);
});
