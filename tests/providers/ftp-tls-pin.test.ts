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
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';

// ─── Real-TLS integration proof for FTPS certificate pinning ─────────────────
//
// This suite is DELIBERATELY unmocked: it uses the real `basic-ftp` client
// against a real `tls.TLSSocket`, so it exercises the exact runtime path the
// provider will take (connect → useTLS → read peer certificate → compare pin →
// login). A mock of `getPeerCertificate` would prove nothing — the whole point
// is that the provider reads a genuinely-presented certificate over a live TLS
// handshake (provider-test-paths.md, proof rule #5: real IO, not just mock).
//
// The binding property is "verify-before-login": with `secure:true` the PASS
// command (which carries the password) must be sent only AFTER the peer
// certificate's fingerprint is confirmed against the configured pin. The test
// server records whether PASS ever arrived, so a pinning failure that still
// leaked the password would be caught.
//
// RED (current code has no pinning): the provider connects via
// `client.access({ secure:true })`, whose default `rejectUnauthorized:true`
// rejects the self-signed fixture certificate at the TLS layer — the operation
// fails with a certificate-validation error (e.g. DEPTH_ZERO_SELF_SIGNED_CERT)
// wrapped in ProviderError, NOT a TamperDetectedError, and never controls
// whether PASS was reached. Assertions target error TYPES and the
// `passReceived` flag, never translated strings (the i18n keys this feature
// needs do not exist yet).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', 'fixtures', 'ftp-tls');
const CERT_PEM = readFileSync(path.join(FIXTURE_DIR, 'cert.pem'));
const KEY_PEM = readFileSync(path.join(FIXTURE_DIR, 'key.pem'));

/** Uppercase colon-hex SHA-256 of the fixture cert's DER — the "known pin". */
const KNOWN_PIN = new X509Certificate(CERT_PEM).fingerprint256;

/**
 * Returns a well-formed but different colon-hex fingerprint by flipping the
 * first octet — a valid pin that does not match the fixture certificate.
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
      // TYPE, STRU, OPTS, PBSZ, PROT and anything else → generic success.
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
    // handshake — the resulting socket error is expected, swallow it.
    socket.on('error', () => {});

    const detachPlain = attachLineReader(socket, (line) => {
      if (line.toUpperCase().startsWith('AUTH')) {
        socket.write('234 Proceed with TLS\r\n');
        // Stop reading plaintext BEFORE wrapping, so the TLSSocket alone
        // consumes the raw bytes (the ClientHello arrives after the client
        // reads our 234, i.e. after this synchronous handler returns).
        detachPlain();
        const tlsSocket = new tls.TLSSocket(socket, { isServer: true, key: KEY_PEM, cert: CERT_PEM });
        // Fires only when the handshake COMPLETES — i.e. the client accepted the
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
  };
}

describe('FtpProvider — FTPS certificate pinning verifies BEFORE login (real TLS socket)', () => {
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

  // MATCH — the pin equals the presented certificate: the operation completes
  // AND PASS was sent, proving login runs only after a successful pin check.
  it('accepts a matching pin and completes login (PASS sent after verification)', async () => {
    const { io } = createMockProviderIO();
    const provider = new FtpProvider(makeFtpConfig(server.port, { cert_fingerprint: KNOWN_PIN }), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).resolves.toBe(1024);
    expect(server.state.passReceived).toBe(true);
  }, 20000);

  // MISMATCH (the key proof) — a valid but wrong pin: the provider must throw
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

  // FAIL-CLOSED — no pin, non-interactive, no TOFU opt-in: an unverifiable
  // certificate must be refused, PASS never sent. This is a policy refusal
  // ("cannot establish trust"), NOT a detected tamper, so it surfaces as a plain
  // ProviderError — mirroring SSH's non-interactive host-key behaviour (a boolean
  // trust denial that the transport turns into a generic ProviderError), not the
  // TamperDetectedError reserved for a pin that mismatches a presented cert.
  //
  // The binding RED signal is tlsEstablished===true: the provider must COMPLETE
  // the TLS handshake (rejectUnauthorized:false), read the presented cert, and
  // only THEN refuse by policy. Current code fails the handshake outright
  // (rejectUnauthorized:true on a self-signed cert) → tlsEstablished stays false.
  // This contract is what lets the TOFU opt-in trust a self-signed cert at all.
  it('fails closed for an unpinned cert in non-interactive mode without --accept-new-cert', async () => {
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const provider = new FtpProvider(makeFtpConfig(server.port, {}), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).rejects.toThrow(ProviderError);
    expect(server.state.passReceived).toBe(false);
    // The provider completes the TLS handshake, reads the cert, and only THEN
    // refuses by policy — destroying the socket immediately. Under TLS 1.3 the
    // client sends its Finished last, so the server's `secure` event can land a
    // tick AFTER the provider has already rejected. Settle briefly so the
    // server-side handshake-complete signal flushes before we assert it: the
    // binding property (handshake reached completion, refusal came from policy,
    // not a TLS-layer rejection) is still what is being verified.
    await new Promise((r) => setTimeout(r, 30));
    expect(server.state.tlsEstablished).toBe(true);
  }, 20000);

  // TOFU opt-in — no pin but accept_new_cert is set (the `--accept-new-cert`
  // flag): the provider trusts the presented certificate and completes login, so
  // PASS is sent.
  it('accepts a new cert under the accept_new_cert opt-in and completes login', async () => {
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const provider = new FtpProvider(makeFtpConfig(server.port, { accept_new_cert: true }), io);
    provider.setVaultName('vault');

    await expect(provider.getSize(SHARD_REF)).resolves.toBe(1024);
    expect(server.state.passReceived).toBe(true);
  }, 20000);

  // SECOND CALL-SITE — verifyShard connects through readHeaderWindowDirect, which
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

  // CAPTURE FLOW — configureInteractive TOFU-captures the presented certificate
  // when TLS is enabled. Established prompt order the GREEN capture must follow
  // (createMockProviderIO answers are keyed by these exact EN strings):
  //   1. io.ask('FTP host:')
  //   2. io.ask('Port (default 21):')
  //   3. io.ask('Username:')
  //   4. io.askSecret('Password:')
  //   5. io.ask('Base path on server:')
  //   6. io.confirm('Use FTPS (secure connection)?')   → if true, capture:
  //   7. connect + useTLS({ rejectUnauthorized:false }) + read peer certificate
  //   8. io.confirm(<cert-trust prompt: fingerprint + self-signed/CA kind>)
  //        accept  → config gains cert_fingerprint (= presented fingerprint256)
  //                  and cert_self_signed (bool)
  //        decline → throw (no pin captured)
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
});
