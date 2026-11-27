import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { Ora } from 'ora';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpinnerIo } from '../../src/cli/spinner-io.js';
import { HostKeyDeclinedError, IdentityDeclinedError, ProviderError, TamperDetectedError, UnsafePathError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import { buildShard, parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmtFor, tFor } from '../../src/i18n/index.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { SshProvider } from '../../src/providers/ssh.js';
import type { CliProviderInput, ConfigureEditContext, ProviderConfig, ProviderIO, RecoverySecret, RemoteRef, ShardHeader, ShardLocation } from '../../src/types/index.js';

// --- Fixed host key + fingerprint contract -----------------------------------
//
// GUESSED API (must match the GREEN implementation): the SSH host-key
// fingerprint is derived from the raw host-key buffer passed to `hostVerifier`
// as `'SHA256:' + base64(sha256(key))` with trailing '=' padding stripped
// (the OpenSSH SHA256 fingerprint form). The default provider config pins this
// fingerprint so every non-host-key test connects silently without a TOFU
// prompt. Host-key-specific tests clear the pin (host_key_fingerprint: null) to
// exercise known_hosts / TOFU.
const SERVER_KEY = Buffer.from('mock-ssh-ed25519-host-key');

/** Mirrors the fingerprint the SSH provider must compute from a host key. */
function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const SERVER_FP = sshFingerprint(SERVER_KEY);

// --- In-memory SSH / SFTP mock -----------------------------------------------

interface MockConnectConfig {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
  hostVerifier?: (key: Buffer, cb: (ok: boolean) => void) => void;
  readyTimeout?: number;
}

interface MockAttrs {
  size: number;
  isDirectory(): boolean;
}

interface MockDirEntry {
  filename: string;
  longname: string;
  attrs: MockAttrs;
}

const mockState: {
  /** Fake SFTP filesystem: full remote path -> bytes. */
  files: Map<string, Buffer>;
  /** Fake SFTP directories: full remote path. */
  dirs: Set<string>;
  /** Connect emits a code-less, level-less transport error (-> unverifiable). */
  connectShouldFail: boolean;
  /** Connect emits an error carrying `level: 'client-authentication'` (-> auth_failed). */
  authShouldFail: boolean;
  /** Raw host-key bytes handed to the client's hostVerifier during handshake. */
  hostKey: Buffer;
  /**
   * Connection lifecycle, in order: 'verifier-answered' when the provider
   * answers hostVerifier, 'end' when it closes the client. Tests append their
   * own markers to place a question relative to the connection.
   */
  events: string[];
  /**
   * Home directory the provider's `os.homedir()` resolves to (mocked). Points
   * at a non-existent path by default so `~/.ssh/known_hosts` reads ENOENT and
   * no real dev-machine known_hosts leaks into a test.
   */
  homeDir: string;
  /**
   * Optional post-write corruption hook. Receives the concatenated bytes that
   * arrived on the write stream; returns what should actually be persisted.
   * Models silent SFTP truncation / byte-flip.
   */
  corruptOnUpload: Nullable<(buf: Buffer) => Buffer>;
  /** Per-attempt byte loss: `uploadByteLossPlan[i]` bytes dropped from the i-th write. */
  uploadByteLossPlan: number[];
  /** Number of write streams finalized since the last reset. */
  uploadAttempt: number;
  /** Sizes of the chunks written by the most recent upload's source stream. */
  lastUploadChunkSizes: number[];
  /** When set, a read stream emits the file in fixed-size chunks (ranged-read observation). */
  downloadChunkSize: Nullable<number>;
  /** Bytes forwarded by the most recent read stream (verifies ranged / header-only reads). */
  lastDownloadBytesWritten: number;
  /** When set, key-auth connect requires cfg.passphrase to equal this (models an encrypted key). */
  keyPassphrase: Nullable<string>;
  /**
   * When true, the write stream emits 'close' but suppresses 'finish' - modeling
   * ssh2's SFTP WriteStream, which closes the remote handle ('close') and never
   * fires 'finish'. Guards against regressing upload to await 'finish' alone.
   */
  suppressWriteFinish: boolean;
  /**
   * When true, SFTP operations after `ready` never respond - readdir/stat
   * callbacks never fire and read streams emit nothing. Models a hung-but-alive
   * server that completes the handshake, then goes silent (the M1 DoS: no
   * per-operation timeout means push/pull/verify hangs forever).
   */
  sftpHang: boolean;
  /**
   * When set, a read stream emits `streamChunks` chunks, one every
   * `streamChunkDelayMs` ms - drives fake-timer tests that the idle timeout
   * RESETS on each received payload (a slow-but-progressing transfer completes).
   */
  streamChunkDelayMs: Nullable<number>;
  streamChunks: number;
  /** When true, every write to an SFTP write stream fails with status 4 (Failure). */
  writeStatus4: boolean;
  /** When true, every SFTP read stream fails with status 4 (Failure). */
  readStatus4: boolean;
} = {
  files: new Map<string, Buffer>(),
  dirs: new Set<string>(),
  connectShouldFail: false,
  authShouldFail: false,
  hostKey: SERVER_KEY,
  events: [],
  homeDir: path.join(os.tmpdir(), 'bfs-ssh-no-home-DOES-NOT-EXIST'),
  corruptOnUpload: null,
  uploadByteLossPlan: [],
  uploadAttempt: 0,
  lastUploadChunkSizes: [],
  downloadChunkSize: null,
  lastDownloadBytesWritten: 0,
  keyPassphrase: null,
  suppressWriteFinish: false,
  sftpHang: false,
  streamChunkDelayMs: null,
  streamChunks: 0,
  /** When true, every write to an SFTP write stream fails with status 4 (Failure). */
  writeStatus4: false,
  /** When true, every SFTP read stream fails with status 4 (Failure). */
  readStatus4: false,
};

/** SFTP-style error: unlike Node's ErrnoException (string code), SFTP carries a numeric status code. */
interface SftpError extends Error {
  code?: number;
}

/** Builds an SFTP-style error carrying a numeric status code (2 = No-Such-File). */
function sftpError(message: string, code: number): SftpError {
  return Object.assign(new Error(message), { code });
}

/** A Readable that immediately fails with `err` (models a read stream on a missing file). */
function erroringReadable(err: Error): Readable {
  return new Readable({
    read(this: Readable) {
      this.destroy(err);
    },
  });
}

/** A Readable that emits `buf`, optionally in fixed-size chunks, counting bytes emitted. */
function dataReadable(buf: Buffer, chunkSize: Nullable<number>): Readable {
  let offset = 0;
  return new Readable({
    read(this: Readable) {
      if (offset >= buf.length) {
        this.push(null);
        return;
      }
      const size = chunkSize ?? buf.length - offset;
      const end = Math.min(offset + size, buf.length);
      const chunk = buf.subarray(offset, end);
      mockState.lastDownloadBytesWritten += chunk.length;
      offset = end;
      this.push(chunk);
    },
  });
}

/** Writable that accumulates bytes, records chunk sizes, and stores on _final. */
class MockWriteStream extends Writable {
  private readonly chunks: Buffer[] = [];

  constructor(private readonly remotePath: string) {
    super();
  }

  override _write(chunk: Buffer | Uint8Array, _enc: string, cb: (err?: Error) => void): void {
    if (mockState.writeStatus4) {
      // OpenSSH speaks SFTP v3, which has no status for "no space left" - a
      // full disk or an exhausted quota comes back as the generic 4 (Failure).
      cb(sftpError('Failure', 4));
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.chunks.push(buf);
    mockState.lastUploadChunkSizes.push(buf.length);
    cb();
  }

  override _final(cb: (err?: Error) => void): void {
    let stored: Buffer = Buffer.concat(this.chunks);
    const loss = mockState.uploadByteLossPlan[mockState.uploadAttempt] ?? 0;
    mockState.uploadAttempt += 1;
    if (loss > 0) stored = Buffer.from(stored.subarray(0, stored.length - loss));
    if (mockState.corruptOnUpload) stored = mockState.corruptOnUpload(stored);
    mockState.files.set(this.remotePath, stored);
    cb();
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // Model ssh2's SFTP WriteStream: 'close' fires (remote handle closed) but
    // 'finish' never does. Swallowing 'finish' proves upload() resolves on
    // 'close' alone. The internal finished->autoDestroy->'close' transition is
    // unaffected (it does not depend on this emit's return value).
    if (mockState.suppressWriteFinish && event === 'finish') return false;
    return super.emit(event, ...args);
  }
}

const mockSftp = {
  readdir(dir: string, cb: (err: Nullable<Error>, list?: MockDirEntry[]) => void): void {
    if (mockState.sftpHang) return; // never respond - models a stalled server after ready
    const entries: MockDirEntry[] = [];
    for (const [key, buf] of mockState.files.entries()) {
      if (key.slice(0, key.lastIndexOf('/')) === dir) {
        entries.push({ filename: key.slice(key.lastIndexOf('/') + 1), longname: key, attrs: { size: buf.length, isDirectory: () => false } });
      }
    }
    for (const d of mockState.dirs) {
      if (d.slice(0, d.lastIndexOf('/')) === dir) {
        entries.push({ filename: d.slice(d.lastIndexOf('/') + 1), longname: d, attrs: { size: 0, isDirectory: () => true } });
      }
    }
    cb(null, entries);
  },

  stat(p: string, cb: (err: Nullable<Error>, stats?: MockAttrs) => void): void {
    if (mockState.sftpHang) return; // never respond - stalled server after ready
    const buf = mockState.files.get(p);
    if (buf) {
      cb(null, { size: buf.length, isDirectory: () => false });
      return;
    }
    if (mockState.dirs.has(p)) {
      cb(null, { size: 0, isDirectory: () => true });
      return;
    }
    cb(sftpError(`No such file: ${p}`, 2));
  },

  createReadStream(p: string, opts?: { start?: number; end?: number }): Readable {
    mockState.lastDownloadBytesWritten = 0;
    // A stalled server: the read stream opens but never delivers a byte (no
    // 'data'/'end'/'error') - the transfer hangs forever without a timeout.
    if (mockState.sftpHang) return new Readable({ read() {} });
    if (mockState.readStatus4) return erroringReadable(sftpError('Failure', 4));
    // A slow-but-progressing transfer: one chunk every streamChunkDelayMs ms.
    if (mockState.streamChunkDelayMs !== null) {
      const delay = mockState.streamChunkDelayMs;
      const total = mockState.streamChunks;
      let sent = 0;
      return new Readable({
        read() {
          if (sent >= total) {
            this.push(null);
            return;
          }
          sent++;
          setTimeout(() => this.push(Buffer.from('x')), delay);
        },
      });
    }
    const buf = mockState.files.get(p);
    if (!buf) return erroringReadable(sftpError(`No such file: ${p}`, 2));
    const start = opts?.start ?? 0;
    const end = opts?.end !== undefined ? opts.end + 1 : buf.length; // SFTP end is inclusive
    const slice = buf.subarray(start, Math.min(end, buf.length));
    return dataReadable(slice, mockState.downloadChunkSize);
  },

  createWriteStream(p: string): Writable {
    mockState.lastUploadChunkSizes = [];
    return new MockWriteStream(p);
  },

  rename(from: string, to: string, cb: (err: Nullable<Error>) => void): void {
    const data = mockState.files.get(from);
    if (!data) {
      cb(sftpError(`No such file: ${from}`, 2));
      return;
    }
    mockState.files.set(to, data);
    mockState.files.delete(from);
    cb(null);
  },

  unlink(p: string, cb: (err: Nullable<Error>) => void): void {
    if (!mockState.files.has(p)) {
      cb(sftpError(`No such file: ${p}`, 2));
      return;
    }
    mockState.files.delete(p);
    cb(null);
  },

  mkdir(p: string, cb: (err: Nullable<Error>) => void): void {
    mockState.dirs.add(p);
    cb(null);
  },
};

vi.mock('ssh2', () => {
  class MockClient {
    private readonly handlers: Record<string, (arg?: unknown) => void> = {};

    on(event: string, cb: (arg?: unknown) => void): this {
      this.handlers[event] = cb;
      return this;
    }

    connect(cfg: MockConnectConfig): this {
      void (async () => {
        await Promise.resolve();
        if (mockState.connectShouldFail) {
          this.emit('error', new Error('ECONNREFUSED'));
          return;
        }
        const proceed = () => {
          if (mockState.authShouldFail) {
            this.emit('error', Object.assign(new Error('All configured authentication methods failed'), { level: 'client-authentication' }));
            return;
          }
          if (mockState.keyPassphrase !== null && cfg.passphrase !== mockState.keyPassphrase) {
            this.emit('error', Object.assign(new Error('Encrypted private key needs a passphrase'), { level: 'client-authentication' }));
            return;
          }
          this.emit('ready');
        };
        if (typeof cfg.hostVerifier === 'function') {
          cfg.hostVerifier(mockState.hostKey, (ok: boolean) => {
            mockState.events.push('verifier-answered');
            if (!ok) {
              // Real ssh2 reports a refused host key as a fatal KEX error with
              // level 'handshake' (protocol/kex.js), not as an authentication
              // failure - a mock saying 'client-authentication' here would make a
              // refused identity look like a rejected password.
              this.emit('error', Object.assign(new Error('Host denied (verification failed)'), { level: 'handshake' }));
              return;
            }
            proceed();
          });
        } else {
          proceed();
        }
      })();
      return this;
    }

    sftp(cb: (err: Nullable<Error>, sftp?: typeof mockSftp) => void): void {
      cb(null, mockSftp);
    }

    end(): void {
      mockState.events.push('end');
    }

    private emit(event: string, arg?: unknown): void {
      this.handlers[event]?.(arg);
    }
  }

  return { Client: MockClient, default: { Client: MockClient } };
});

// The provider resolves `~` via os.homedir() for known_hosts and default-key
// discovery. Redirect it to a controlled temp dir so tests never touch the real
// dev-machine ~/.ssh; preserve tmpdir() and every other os member.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => mockState.homeDir || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// --- Helpers -----------------------------------------------------------------

/**
 * Scratch directories handed out by writeJsonConfig, emptied after every test -
 * so a path it returns must not be used outside the test that asked for it.
 */
const configDirs: string[] = [];

afterEach(async () => {
  // Swallow removal errors: a test that already passed must not turn red because
  // something else on the machine still held the file for a moment.
  await Promise.all(configDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

async function writeJsonConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ssh-cfg-'));
  configDirs.push(dir);
  const file = path.join(dir, 'ssh.json');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function cliInput(overrides: Partial<CliProviderInput> = {}): CliProviderInput {
  return { name: overrides.name ?? 'test', rawArgs: overrides.rawArgs ?? [] };
}

/**
 * Calls the optional `takeConfigUpdates` of a provider; a provider that does not
 * implement it answers with a marker string, so an assertion on the update
 * fails naming the missing hook instead of passing on `undefined`.
 */
function takeUpdates(provider: object): unknown {
  const hook = (provider as { takeConfigUpdates?: () => unknown }).takeConfigUpdates;
  return typeof hook === 'function' ? hook.call(provider) : 'takeConfigUpdates is not implemented';
}

function makeConfig(overrides: Partial<Record<string, unknown>> = {}, id = 'test-ssh'): ProviderConfig {
  return { id, type: 'ssh', adapterPackage: null, config: { host: 'sshhost', port: 22, user: 'sshuser', password: 'sshpass', path: '/backup', auth_method: 'password', host_key_fingerprint: SERVER_FP, ...overrides } };
}

const TEST_LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'test-ssh', provider_type: 'ssh', adapterPackage: null, connection_config: { host: 'sshhost', path: '/backup' }, required_inputs: [], remote_path: '/backup/vault/shard_0.bfs.1', shard_hash: 'a'.repeat(64) },
];

function makeHeader(overrides: Partial<ShardHeader> = {}): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 1,
    vault_id: '550e8400-e29b-41d4-a716-446655440000',
    vault_name: 'testvault',
    blob_size: 256n,
    blob_hash: 'b'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: null,
    map_length: 0,
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
}

async function uploadBuf(provider: SshProvider, filename: string, data: Buffer) {
  return provider.upload(filename, Readable.from(data), data.length);
}

async function downloadBuf(provider: SshProvider, ref: { provider_id: string; path: string }): Promise<Buffer> {
  return streamToBuffer(await provider.download(ref));
}

interface RecordedCall {
  kind: 'ask' | 'askSecret' | 'confirm' | 'choose' | 'info' | 'debug' | 'warn';
  text: string;
  options?: string[];
}

/**
 * A fully scripted ProviderIO that records every interaction. Handlers control
 * return values; `choose` receives the option list so a test can pick by index
 * without depending on exact (i18n) option wording.
 */
function scriptIo(h: { ask?(prompt: string): string; askSecret?(prompt: string): string; confirm?(message: string): boolean; choose?(message: string, options: string[]): string; interactive?: boolean } = {}): {
  io: ProviderIO;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const io: ProviderIO = {
    lang: 'en',
    workDir: process.cwd(),
    interactive: h.interactive ?? true,
    async ask(prompt: string): Promise<string> {
      calls.push({ kind: 'ask', text: prompt });
      return h.ask?.(prompt) ?? '';
    },
    async askSecret(prompt: string): Promise<string> {
      calls.push({ kind: 'askSecret', text: prompt });
      return h.askSecret?.(prompt) ?? '';
    },
    async confirm(message: string): Promise<boolean> {
      calls.push({ kind: 'confirm', text: message });
      return h.confirm?.(message) ?? false;
    },
    async choose(message: string, options: string[]): Promise<string> {
      calls.push({ kind: 'choose', text: message, options });
      return h.choose?.(message, options) ?? options[0] ?? '';
    },
    info(message: string): void {
      calls.push({ kind: 'info', text: message });
    },
    debug(message: string): void {
      calls.push({ kind: 'debug', text: message });
    },
    warn(message: string): void {
      calls.push({ kind: 'warn', text: message });
    },
    progress(): void {},
  };
  return { io, calls };
}

// configureInteractive answers keyed by prompt keyword (robust to exact wording).
// 'key' is checked before 'path' because the private-key prompt contains both.
function interactiveAsk(prompt: string): string {
  const p = prompt.toLowerCase();
  if (p.includes('host')) return 'ssh.example.com';
  if (p.includes('port')) return '2222';
  if (p.includes('user')) return 'alice';
  if (p.includes('key') || p.includes('private')) return '/home/alice/.ssh/id_ed25519';
  if (p.includes('path')) return '/backup';
  return '';
}

/** The three exits of the host-key decision asked while settings are collected. */
const TRUST_OPTIONS = [fmtFor('en', 'trust_choice_accept'), fmtFor('en', 'trust_choice_back'), fmtFor('en', 'trust_choice_cancel')];

type TrustPick = 'accept' | 'back' | 'cancel';

/** True when a choose() call is the host-key decision menu. */
function isTrustMenu(options: readonly string[]): boolean {
  return options.length === TRUST_OPTIONS.length && options.every((o, i) => o === TRUST_OPTIONS[i]);
}

/**
 * choose() handler: picks the auth method by position on the auth menu and
 * answers the n-th host-key decision menu with `picks[n]`. `onTrust(n)` runs
 * before the n-th answer, so a test can change what the "next server" presents.
 * Running out of picks throws, so a flow that keeps going back fails with a
 * reason instead of looping.
 */
function chooseAuthAndTrust(auth: 0 | 1, picks: readonly TrustPick[], onTrust?: (pass: number) => void): (message: string, options: string[]) => string {
  let pass = 0;
  return (_message: string, options: string[]): string => {
    if (!isTrustMenu(options)) return options[auth] ?? '';
    const pick = picks[pass];
    if (pick === undefined) throw new Error(`host-key menu shown ${pass + 1} times, only ${picks.length} answers scripted`);
    onTrust?.(pass);
    pass += 1;
    return TRUST_OPTIONS[{ accept: 0, back: 1, cancel: 2 }[pick]] ?? '';
  };
}

/** True when a choose() call is the offline host-key menu of an edit. */
function isOfflineMenu(options: readonly string[]): boolean {
  return options.includes(fmtFor('en', 'ssh_edit_offline_exit'));
}

/** How many times the SSH host prompt was asked (the private-key prompt excluded). */
function hostPrompts(calls: readonly RecordedCall[]): number {
  return calls.filter((c) => c.kind === 'ask' && /host/i.test(c.text) && !/key/i.test(c.text)).length;
}

const createdHomes: string[] = [];

/** Creates a real temp home directory (with an empty `.ssh`) and tracks it for cleanup. */
async function makeTempHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ssh-home-'));
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true });
  createdHomes.push(home);
  return home;
}

function resetMockState(): void {
  mockState.files.clear();
  mockState.dirs.clear();
  mockState.connectShouldFail = false;
  mockState.authShouldFail = false;
  mockState.hostKey = SERVER_KEY;
  mockState.events = [];
  mockState.homeDir = path.join(os.tmpdir(), 'bfs-ssh-no-home-DOES-NOT-EXIST');
  mockState.corruptOnUpload = null;
  mockState.uploadByteLossPlan = [];
  mockState.uploadAttempt = 0;
  mockState.lastUploadChunkSizes = [];
  mockState.downloadChunkSize = null;
  mockState.lastDownloadBytesWritten = 0;
  mockState.keyPassphrase = null;
  mockState.suppressWriteFinish = false;
  mockState.sftpHang = false;
  mockState.streamChunkDelayMs = null;
  mockState.streamChunks = 0;
  mockState.writeStatus4 = false;
  mockState.readStatus4 = false;
}

// --- Tests -------------------------------------------------------------------

describe('SshProvider', () => {
  let provider: SshProvider;

  beforeEach(() => {
    resetMockState();
    const { io } = createMockProviderIO();
    provider = new SshProvider(makeConfig(), io);
    provider.setVaultName('testvault');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const home of createdHomes) {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
    createdHomes.length = 0;
  });

  // --- constructor (lazy init - validation via validateConfig) -------------

  it('should NOT throw when host is missing - config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider(makeConfig({ host: '' }), io)).not.toThrow();
  });

  it('should NOT throw when path is missing - config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider(makeConfig({ path: '' }), io)).not.toThrow();
  });

  it('should accept an empty config object for placeholder use in configure flows', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io)).not.toThrow();
  });

  // --- diagnostic logging (gated by `bfs --debug`) -------------------------

  it('should route the connection log through io.debug, not io.info', async () => {
    const { io, logs } = createMockProviderIO();
    const localProvider = new SshProvider(makeConfig(), io);
    localProvider.setVaultName('testvault');

    await uploadBuf(localProvider, 'shard_0.bfs.1', Buffer.alloc(64, 1));

    const connectLogs = logs.filter((l) => l.message.includes('sshhost'));
    expect(connectLogs.length).toBeGreaterThan(0);
    for (const entry of connectLogs) {
      expect(entry.level).toBe('debug');
    }
    expect(logs.find((l) => l.level === 'info' && l.message.includes('sshhost'))).toBeUndefined();
  });

  // --- control-character / traversal rejection in vault name ---------------

  it('should reject a vault name containing a line break before any SFTP operation', async () => {
    const { io } = createMockProviderIO();
    const p = new SshProvider(makeConfig(), io);
    p.setVaultName('vault\r\nDELE secret');

    await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.alloc(8, 1))).rejects.toThrow(ProviderError);
  });

  it('should reject a vault name containing a NUL byte before any SFTP operation', async () => {
    const { io } = createMockProviderIO();
    const p = new SshProvider(makeConfig(), io);
    p.setVaultName('vault\0evil');

    await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.alloc(8, 1))).rejects.toThrow(ProviderError);
  });

  it('should reject a vault name with a parent-traversal segment before any SFTP operation', async () => {
    const { io } = createMockProviderIO();
    const p = new SshProvider(makeConfig(), io);
    p.setVaultName('../evil');

    await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.alloc(8, 1))).rejects.toThrow(UnsafePathError);
  });

  // --- upload / download roundtrip -----------------------------------------

  it('should upload and download identical binary data', async () => {
    const data = Buffer.alloc(512);
    for (let i = 0; i < 512; i++) data[i] = i % 256;

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);

    expect(downloaded).toEqual(data);
  });

  it('should explain an SFTP "Failure" status on write as a likely full disk or quota', async () => {
    // SFTP v3 has no status for a full disk, so the server answers a write
    // with the generic 4 (Failure). Handed over bare, "Failure" tells the
    // operator nothing; the adapter owns the medium's semantics and must add
    // what that status most often means on a write.
    mockState.writeStatus4 = true;

    let failure: unknown = null;
    try {
      await uploadBuf(provider, 'shard_0.bfs.1', Buffer.alloc(512, 1));
    } catch (err: unknown) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(ProviderError);
    const message = (failure as ProviderError).message;
    expect(message, 'the likely meaning of the status must be spelled out').toMatch(/space|quota/i);
    expect(message, 'the bare status word must not be the whole explanation').not.toMatch(/:\s*Failure\s*$/);
  });

  it('should not read a full disk into an SFTP "Failure" status on a download (A/B control)', async () => {
    // The same status on a read means something else entirely; the hint
    // belongs to the write path, not to every status 4 the connection sees.
    mockState.readStatus4 = true;

    let failure: unknown = null;
    try {
      await downloadBuf(provider, { provider_id: 'test-ssh', path: 'shard_0.bfs.1' });
    } catch (err: unknown) {
      failure = err;
    }

    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).message).not.toMatch(/space|quota/i);
  });

  it('should return correct provider_id, path, and 64-char hash after upload', async () => {
    const data = Buffer.from('test-data');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(ref.provider_id).toBe('test-ssh');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64);
  });

  // --- post-upload verification (defense against silent SFTP corruption) ----

  it('should throw ProviderError when the server stored fewer bytes than uploaded', async () => {
    // The post-upload `stat` reports the truncated size, so the size check fails.
    mockState.corruptOnUpload = (buf) => buf.subarray(0, buf.length - 1);
    const data = Buffer.alloc(256, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).rejects.toThrow(ProviderError);
  });

  // --- chunking regression (CRITICAL) --------------------------------------

  it('should split a multi-chunk-sized payload across multiple stream chunks', async () => {
    // Regression: `Readable.from(buffer)` pushes the whole buffer as one chunk,
    // which silently truncates on some SFTP transports for multi-MB uploads. The
    // provider must emit fixed-size chunks (~64 KB) to cooperate with backpressure.
    const data = Buffer.alloc(200 * 1024, 0xab);

    await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(mockState.lastUploadChunkSizes.length).toBeGreaterThan(1);
    const maxChunk = Math.max(...mockState.lastUploadChunkSizes);
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
  });

  it('should resolve upload when the write stream emits close but never finish', async () => {
    // Regression: ssh2's SFTP WriteStream closes the remote handle (emitting
    // 'close') but never emits 'finish'. An upload path that awaits 'finish'
    // alone hangs forever against a real server - invisible to a mock that emits
    // both. With 'finish' suppressed, upload() must still resolve (via 'close').
    mockState.suppressWriteFinish = true;
    const data = Buffer.alloc(4 * 1024, 0xcd);

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(ref.path).toBe('shard_0.bfs.1');
    expect(mockState.files.get('/backup/testvault/shard_0.bfs.1')?.length).toBe(data.length);
  });

  // --- list ----------------------------------------------------------------

  it('should list all uploaded files', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('b'));

    const refs = await provider.list();
    const names = refs.map((r: RemoteRef) => r.path).sort();

    expect(names).toEqual(['shard_0.bfs.1', 'shard_1.bfs.1']);
  });

  it('should filter list by prefix', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_0.bfs.2', Buffer.from('b'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('c'));

    const refs = await provider.list('shard_0');

    expect(refs.map((r: RemoteRef) => r.path).sort()).toEqual(['shard_0.bfs.1', 'shard_0.bfs.2']);
  });

  it('should return empty list when vault has no files', async () => {
    const refs = await provider.list();
    expect(refs).toEqual([]);
  });

  // --- delete --------------------------------------------------------------

  it('should delete a file', async () => {
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('data'));
    await provider.delete(ref);

    const refs = await provider.list();
    expect(refs.map((r: RemoteRef) => r.path)).not.toContain('shard_0.bfs.1');
  });

  // Deleting an already-absent shard is idempotent (success), not an error - see
  // the "hardening" block (L6). It must not raise a false prune orphan warning.

  // --- healthCheck ---------------------------------------------------------

  it('should return true when connection succeeds', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false when connection fails', async () => {
    mockState.connectShouldFail = true;
    expect(await provider.healthCheck()).toBe(false);
  });

  // --- authenticate --------------------------------------------------------

  it('should not throw when connection succeeds', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should throw ProviderError when connection fails', async () => {
    mockState.connectShouldFail = true;
    await expect(provider.authenticate()).rejects.toThrow(ProviderError);
  });

  // --- rename --------------------------------------------------------------

  it('should rename a file and make old path unavailable', async () => {
    const ref = await uploadBuf(provider, 'shard_0.bfs.1.tmp', Buffer.from('payload'));

    const newRef = await provider.rename(ref, 'shard_0.bfs.1');
    expect(newRef.path).toBe('shard_0.bfs.1');

    const downloaded = await downloadBuf(provider, newRef);
    expect(downloaded).toEqual(Buffer.from('payload'));

    const refs = await provider.list();
    const names = refs.map((r: RemoteRef) => r.path);
    expect(names).not.toContain('shard_0.bfs.1.tmp');
    expect(names).toContain('shard_0.bfs.1');
  });

  // --- updateShardHeader ---------------------------------------------------

  it('should update shard header, keep payload intact, and recompute checksum', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalShard = buildShard(makeHeader({ shard_index: 0 }), payload);

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    const updatedHeader = makeHeader({ shard_index: 0, location_map: [{ ...TEST_LOCATIONS[0], remote_path: '/new/path/shard_0.bfs.1', shard_hash: 'c'.repeat(64) }] });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await provider.updateShardHeader(ref, newHeaderData);

    const updatedBuf = await downloadBuf(provider, ref);
    const { header: h, payloadStream } = await parseShardHeaderFromStream(Readable.from(updatedBuf));
    const p = await streamToBuffer(payloadStream);

    expect(p).toEqual(payload);
    expect(h.location_map[0].remote_path).toBe('/new/path/shard_0.bfs.1');
  });

  it('should throw ProviderError with a size diff when updateShardHeader stores fewer bytes than sent', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalShard = buildShard(makeHeader({ shard_index: 0 }), payload);
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    // Corruption fires only for the rewrite triggered by updateShardHeader.
    mockState.corruptOnUpload = (buf) => buf.subarray(0, buf.length - 1);

    const newShardForHeader = buildShard(makeHeader({ shard_index: 0 }), Buffer.alloc(0));
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await expect(provider.updateShardHeader(ref, newHeaderData)).rejects.toThrow(ProviderError);
  });

  it('should throw ProviderError when the stored shard is shorter than header + checksum', async () => {
    // A shard truncated to one byte below header + the 32-byte checksum trips the
    // short-shard guard (existing.length < oldHeaderSize + CHECKSUM_SIZE).
    const minimalShard = buildShard(makeHeader({ shard_index: 0 }), Buffer.alloc(0));
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', minimalShard.subarray(0, minimalShard.length - 1));

    const newShardForHeader = buildShard(makeHeader({ shard_index: 0 }), Buffer.alloc(0));
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await expect(provider.updateShardHeader(ref, newHeaderData)).rejects.toThrow(ProviderError);
  });

  // --- listVaults ----------------------------------------------------------

  it('should list vault directories from basePath', async () => {
    mockState.dirs.add('/backup/vault-a');
    mockState.dirs.add('/backup/vault-b');

    const { io } = createMockProviderIO();
    const p = new SshProvider(makeConfig(), io);
    const vaults = await p.listVaults();

    expect(vaults.sort()).toEqual(['vault-a', 'vault-b']);
  });

  // --- getSize --------------------------------------------------------------

  describe('getSize', () => {
    it('should return shard size via stat without transferring the payload', async () => {
      const data = Buffer.alloc(8192, 0x55);
      await uploadBuf(provider, 'shard_0.bfs.1', data);
      mockState.lastDownloadBytesWritten = 0;

      const size = await provider.getSize({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' });

      expect(size).toBe(8192);
      expect(mockState.lastDownloadBytesWritten).toBe(0);
    });

    it('should throw ProviderError when the shard is missing', async () => {
      await expect(provider.getSize({ provider_id: 'test-ssh', path: 'missing.bfs.1' })).rejects.toThrow(ProviderError);
    });
  });

  // --- downloadHeader -------------------------------------------------------

  describe('downloadHeader', () => {
    it('should pull the whole file when size <= maxBytes', async () => {
      const data = Buffer.from('tiny');
      await uploadBuf(provider, 'shard_0.bfs.1', data);

      const head = await provider.downloadHeader({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, 1024);

      expect(head.length).toBe(4);
      expect(head.toString()).toBe('tiny');
    });

    it('should read only maxBytes via a ranged read for a larger shard', async () => {
      // 200 KB shard, ask for 8 KB. SFTP native ranged read pulls only the range.
      const data = Buffer.alloc(200 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      await uploadBuf(provider, 'shard_0.bfs.1', data);
      mockState.downloadChunkSize = 4096;

      const head = await provider.downloadHeader({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, 8192);

      expect(head.length).toBe(8192);
      expect(Buffer.compare(head, data.subarray(0, 8192))).toBe(0);
      expect(mockState.lastDownloadBytesWritten).toBeLessThanOrEqual(8192);
      expect(mockState.lastDownloadBytesWritten).toBeLessThan(data.length);
    });

    it('should throw ProviderError for a missing shard', async () => {
      await expect(provider.downloadHeader({ provider_id: 'test-ssh', path: 'missing.bfs.1' }, 1024)).rejects.toThrow(ProviderError);
    });

    it('should reject maxBytes <= 0', async () => {
      await expect(provider.downloadHeader({ provider_id: 'test-ssh', path: 'whatever' }, 0)).rejects.toThrow(ProviderError);
    });
  });

  // --- configureInteractive (dual-auth) -------------------------------------

  describe('configureInteractive', () => {
    it('should prompt for all fields and return a password-method config', async () => {
      // Auth menu: first option = password auth (option order [password, key]).
      // Host-key menu: "trust" pins the fingerprint.
      const { io } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['accept']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', path: '/backup', auth_method: 'password', password: 'supersecret', host_key_fingerprint: SERVER_FP });
      expect(config.private_key_path).toBeUndefined();
    });

    it('should collect a private key by PATH only (never prompt to paste the key body)', async () => {
      // Auth menu: second option = key auth. No passphrase (askSecret -> '').
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => '', choose: chooseAuthAndTrust(1, ['accept']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', path: '/backup', auth_method: 'key', private_key_path: '/home/alice/.ssh/id_ed25519', host_key_fingerprint: SERVER_FP });
      expect(config.password).toBeUndefined();
      // The key is collected as a PATH via ask(); no prompt asks to paste the body.
      const askedForKeyPath = calls.some((c) => c.kind === 'ask' && /key|private/i.test(c.text));
      expect(askedForKeyPath).toBe(true);
      const promptedForBody = calls.some((c) => /paste|contents|body|begin/i.test(c.text));
      expect(promptedForBody).toBe(false);
    });

    it('should collect a key passphrase via askSecret when one is entered', async () => {
      const { io } = scriptIo({ ask: interactiveAsk, askSecret: (p) => (/phrase/i.test(p) ? 'keypass' : ''), choose: chooseAuthAndTrust(1, ['accept']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toMatchObject({ auth_method: 'key', private_key_path: '/home/alice/.ssh/id_ed25519', passphrase: 'keypass', host_key_fingerprint: SERVER_FP });
    });

    it('should default the port to 22 when the user leaves it empty', async () => {
      const ask = (prompt: string): string => (/port/i.test(prompt) ? '' : interactiveAsk(prompt));
      const { io } = scriptIo({ ask, askSecret: () => 'secret', choose: chooseAuthAndTrust(0, ['accept']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.port).toBe(22);
      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    // configureInteractive owns TOFU: after collecting parameters it connects,
    // reads the host key, consults ~/.ssh/known_hosts (entry -> trust silently),
    // else puts the key to the operator and pins host_key_fingerprint on
    // acceptance - because `bfs init` persists ONLY configureInteractive's result,
    // not the probeConnection connect. The TOFU host-key scan captures the key
    // during the handshake and does not require the private key file to be
    // readable. The decision has three exits, like the FTPS certificate menu:
    // refusing a key usually means "wrong server", and a yes/no would cost the
    // operator every field already typed.
    it('should put the host key to the operator as a menu with trust, back and cancel, and pin it on trust', async () => {
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['accept']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      const menus = calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []));
      expect(menus).toHaveLength(1);
      expect(menus[0]?.text).toBe(fmtFor('en', 'ssh_host_key_trust_menu', 'alice@ssh.example.com:2222', SERVER_FP));
      expect(menus[0]?.options).toEqual(TRUST_OPTIONS);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    // The question waits for the operator, and a decision taken inside the
    // handshake would run against the connection's readyTimeout: an operator who
    // checks the fingerprint for longer than that gets a connection error while
    // the question is still on screen. So the key is read and the connection
    // closed first, and only then is anyone asked.
    it('should ask about the host key only after the connection that read it is closed', async () => {
      const { io } = scriptIo({
        ask: interactiveAsk,
        askSecret: () => 'supersecret',
        choose: chooseAuthAndTrust(0, ['accept'], () => {
          mockState.events.push('menu');
        }),
      });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      await p.configureInteractive(io);

      expect(mockState.events).toEqual(['verifier-answered', 'end', 'menu']);
    });

    it('should end the configuration with HostKeyDeclinedError when the operator cancels at the host key', async () => {
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['cancel']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      await expect(p.configureInteractive(io)).rejects.toThrow(HostKeyDeclinedError);
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(1);
      // Cancelling ends the command; it does not lead back to the prompts.
      expect(hostPrompts(calls)).toBe(1);
    });

    // With nobody to work a menu, an unknown key is refused before any question,
    // naming the way out - the menu must not replace that refusal.
    it('should refuse an unknown key without asking when nobody can answer', async () => {
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['accept']), confirm: () => true, interactive: false });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      await expect(p.configureInteractive(io)).rejects.toThrow(HostKeyDeclinedError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toBe(false);
      expect(calls.some((c) => c.kind === 'warn' && c.text === fmtFor('en', 'ssh_host_key_tofu_refused', 'alice@ssh.example.com:2222'))).toBe(true);
    });

    // The mirror direction: the operator goes back from a live server A and
    // aims at a live server B. B must be pinned with ITS OWN key - nothing read
    // during the abandoned pass may survive into the config.
    it('should collect the fields again after "back" and pin the key the second server presents', async () => {
      const otherKey = Buffer.from('mock-ssh-ed25519-host-key-of-server-b');
      const { io, calls } = scriptIo({
        ask: interactiveAsk,
        askSecret: () => 'supersecret',
        choose: chooseAuthAndTrust(0, ['back', 'accept'], (pass) => {
          if (pass === 0) mockState.hostKey = otherKey;
        }),
      });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.host_key_fingerprint).toBe(sshFingerprint(otherKey));
      expect(hostPrompts(calls)).toBe(2);
      expect(calls.some((c) => c.kind === 'info' && c.text === fmtFor('en', 'configure_reenter_notice'))).toBe(true);
    });

    it('should stop going back after the restart budget and say so', async () => {
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['back', 'back', 'back', 'back', 'back']) });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      await expect(p.configureInteractive(io)).rejects.toThrow(fmtFor('en', 'configure_restarts_exhausted'));
      // One first pass plus MAX_CONFIGURE_RESTARTS (3) returns to the prompts.
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(4);
    });

    it('should pin silently (no prompt) when the host is already in ~/.ssh/known_hosts', async () => {
      const home = await makeTempHome();
      // Interactive host is ssh.example.com on the default port 22, so the
      // known_hosts key is the bare hostname (no [host]:port bracket form).
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `ssh.example.com ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const ask = (prompt: string): string => (/port/i.test(prompt) ? '' : interactiveAsk(prompt));
      const { io, calls } = scriptIo({ ask, askSecret: () => 'supersecret', choose: chooseAuthAndTrust(0, ['cancel']), confirm: () => false });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toBe(false);
    });
  });

  // --- configureFromFlags ---------------------------------------------------

  describe('configureFromFlags', () => {
    it('should throw ProviderError when no config source is given', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput())).rejects.toThrow(ProviderError);
    });

    it('should accept a full inline password spec', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'ssh.example.com', '--port', '2222', '--user', 'alice', '--password', 'secret', '--path', '/backup'] }));

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', password: 'secret', path: '/backup', auth_method: 'password' });
      expect(config.private_key_path).toBeUndefined();
    });

    it('should accept a full inline private-key spec', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'ssh.example.com', '--port', '2222', '--user', 'alice', '--private-key', '/keys/id_ed25519', '--path', '/backup'] }));

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', private_key_path: '/keys/id_ed25519', path: '/backup', auth_method: 'key' });
      expect(config.password).toBeUndefined();
    });

    it('should reject providing both --password and --private-key (auth is password XOR key)', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b', '--password', 'p', '--private-key', '/k'] }))).rejects.toThrow(ProviderError);
    });

    it('should default the port to 22 when --port omitted', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b', '--password', 'p'] }));

      expect(config.port).toBe(22);
    });

    it('should reject --port outside 1..65535', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b', '--password', 'p', '--port', '99999'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject a non-numeric --port', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b', '--password', 'p', '--port', 'abc'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject an inline --path that is not absolute', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--password', 'p', '--path', 'relative/x'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject when --host is missing entirely', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--user', 'u', '--password', 'p', '--path', '/b'] }))).rejects.toThrow(ProviderError);
    });

    it('should parse a valid JSON config file (login/password)', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'ssh.example.com', port: 2222, user: 'alice', password: 'secret', path: '/backup' }));
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', password: 'secret', path: '/backup', auth_method: 'password' });
    });

    it('should let inline flags override --config-file fields', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'ssh.example.com', port: 22, user: 'alice', password: 'json-pass', path: '/backup' }));
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file, '--password', 'override'] }));

      expect(config.password).toBe('override');
    });

    it('should throw on malformed JSON', async () => {
      const file = await writeJsonConfig('{ not valid json');
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    // The opt-in counts from the assembled config, not from the raw flag: an
    // `accept_new_host_key: true` in --config-file is consent from this very
    // invocation, so it captures and pins the presented key exactly like the
    // flag. A command that writes the config therefore never leaves a bare
    // opt-in in config.json.
    it('should pin the presented fingerprint for accept_new_host_key read from --config-file', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', accept_new_host_key: true }));
      const { io, calls } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });

    // The offline edit refuses the opt-in however it arrived - from the flag or
    // from --config-file - since the capture needs a connection it does not make.
    it('should refuse accept_new_host_key read from --config-file on an offline edit', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', accept_new_host_key: true }));
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags({ ...cliInput({ rawArgs: ['--config-file', file] }), offline: true })).rejects.toThrow(ProviderError);
    });

    // A config copied out of BFS's own config.json carries the opt-in next to the
    // pin. With the pin there is nothing to capture, so the offline edit goes on.
    it('should accept accept_new_host_key with a pin beside it on an offline edit', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', accept_new_host_key: true, host_key_fingerprint: SERVER_FP }));
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags({ ...cliInput({ rawArgs: ['--config-file', file] }), offline: true });

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    // An empty pin is no pin: the connection treats it as none, and so does the
    // unattended trust-basis guard. It reaches the assembled config from a
    // settings file (an offline "save without pinning" stores "", and the
    // operator adds the opt-in next to it) or from an empty --known-host (a
    // script whose pin variable is unset). Reading "" as a pin skips the capture
    // and stores a bare opt-in - which every unattended run then refuses.
    it('should pin the presented fingerprint for accept_new_host_key next to an empty pin from --config-file', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', accept_new_host_key: true, host_key_fingerprint: '' }));
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    it('should refuse accept_new_host_key next to an empty pin on an offline edit', async () => {
      // Nothing is pinned, so the opt-in still needs the capture an offline edit
      // cannot make - the same refusal as with no pin at all.
      const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', accept_new_host_key: true, host_key_fingerprint: '' }));
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const refusal = p.configureFromFlags({ ...cliInput({ rawArgs: ['--config-file', file] }), offline: true });

      await expect(refusal).rejects.toBeInstanceOf(ProviderError);
      await expect(refusal).rejects.toThrow(tFor('en', 'ssh_accept_new_offline'));
    });

    // The rule reads the assembled config, not one source: an empty --known-host
    // must count as no pin just like an empty value from the settings file.
    const EMPTY_INLINE_PIN = ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--known-host', '', '--accept-new-host-key'];

    it('should pin the presented fingerprint for --accept-new-host-key next to an empty --known-host', async () => {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: EMPTY_INLINE_PIN }));

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    it('should refuse --accept-new-host-key next to an empty --known-host on an offline edit', async () => {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const refusal = p.configureFromFlags({ ...cliInput({ rawArgs: EMPTY_INLINE_PIN }), offline: true });

      await expect(refusal).rejects.toBeInstanceOf(ProviderError);
      await expect(refusal).rejects.toThrow(tFor('en', 'ssh_accept_new_offline'));
    });

    // An unattended run that names no basis for trusting the server - no pin,
    // no opt-in, no known_hosts entry for host:port - cannot end anywhere but in
    // a refusal at the first connection. The adapter refuses while it parses the
    // flags instead, naming both ways out, so no connection is attempted. The
    // pin, the opt-in and the port all arrive through --config-file too, so the
    // guard reads the assembled configuration, not the raw flags.
    describe('host-key trust basis in an unattended run', () => {
      const flags = ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup'];
      const otherKey = Buffer.from('some-other-host-key').toString('base64');

      /** A known_hosts line in OpenSSH's hashed form (`HashKnownHosts yes`). */
      function hashedKnownHostsLine(hostPattern: string, keyB64: string): string {
        const salt = Buffer.from('0123456789abcdef0123');
        const digest = createHmac('sha1', salt).update(hostPattern).digest();
        return `|1|${salt.toString('base64')}|${digest.toString('base64')} ssh-ed25519 ${keyB64}\n`;
      }

      it('should refuse before connecting when nothing says how to trust the host key', async () => {
        mockState.connectShouldFail = true;
        const { io, calls } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const err = await p.configureFromFlags(cliInput({ rawArgs: flags })).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        const message = (err as Error).message;
        expect(message).toContain('Conflicting instructions');
        expect(message).toContain('sshhost:22');
        expect(message).toContain('--accept-new-host-key');
        expect(message).toContain('--known-host');
        expect(calls.some((c) => c.kind === 'confirm' || c.kind === 'choose')).toBe(false);
      });

      // An empty pin is what an offline edit saves when the operator chose not
      // to pin; the connection treats it as no pin, so the guard must as well.
      it('should refuse an empty pin read from --config-file', async () => {
        const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', host_key_fingerprint: '' }));
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const err = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] })).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        expect((err as Error).message).toContain('--accept-new-host-key');
      });

      it('should word the refusal in Polish for a Polish operator', async () => {
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, { ...io, lang: 'pl' });

        const err = await p.configureFromFlags(cliInput({ rawArgs: flags })).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        const message = (err as Error).message;
        expect(message).toContain('sshhost:22');
        expect(message).toContain('--accept-new-host-key');
        expect(message).toContain('--known-host');
        expect(message).toContain('Sprzeczne polecenia');
      });

      it('should still refuse when the only known_hosts entry for the host is @revoked', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
        mockState.homeDir = home;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const err = await p.configureFromFlags(cliInput({ rawArgs: flags })).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        expect((err as Error).message).toContain('--accept-new-host-key');
      });

      // A rotated key leaves the old line marked @revoked next to the new one;
      // the trusted line is still a basis.
      it('should pass when a trusted entry stands next to an @revoked one', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${otherKey}\nsshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
        mockState.homeDir = home;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: flags }));

        expect(config.host).toBe('sshhost');
      });

      it('should still refuse when known_hosts names the host only on another port', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
        mockState.homeDir = home;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const err = await p.configureFromFlags(cliInput({ rawArgs: [...flags, '--port', '2222'] })).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ProviderError);
        expect((err as Error).message).toContain('sshhost:2222');
        expect((err as Error).message).toContain('--known-host');
      });

      // The entry is a trust basis; whether the server still presents that key
      // is the handshake's question, answered there, not while parsing flags.
      it('should pass when known_hosts holds an entry for host:port, even for a different key', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${otherKey}\n`, 'utf8');
        mockState.homeDir = home;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: flags }));

        expect(config.host).toBe('sshhost');
      });

      it('should pass with a pinned fingerprint from --known-host', async () => {
        mockState.connectShouldFail = true;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: [...flags, '--known-host', SERVER_FP] }));

        expect(config.host_key_fingerprint).toBe(SERVER_FP);
      });

      // The shape the adapter's own help documents for --config-file; a guard
      // that inspected the raw flags would refuse it.
      it('should pass with a fingerprint pinned in --config-file', async () => {
        mockState.connectShouldFail = true;
        const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', user: 'sshuser', password: 'p', path: '/backup', host_key_fingerprint: SERVER_FP }));
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

        expect(config.host_key_fingerprint).toBe(SERVER_FP);
      });

      // The port comes from --config-file, so known_hosts is asked about the
      // assembled host:port - here in its bracketed `[host]:port` form.
      it('should pass when known_hosts holds a [host]:port entry for the port read from --config-file', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `[sshhost]:2222 ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
        mockState.homeDir = home;
        const file = await writeJsonConfig(JSON.stringify({ host: 'sshhost', port: 2222, user: 'sshuser', password: 'p', path: '/backup' }));
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

        expect(config.port).toBe(2222);
      });

      it('should pass when known_hosts holds the host in hashed form', async () => {
        const home = await makeTempHome();
        await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), hashedKnownHostsLine('sshhost', SERVER_KEY.toString('base64')), 'utf8');
        mockState.homeDir = home;
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: flags }));

        expect(config.host).toBe('sshhost');
      });

      it('should pass with --accept-new-host-key and pin the presented key', async () => {
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: [...flags, '--accept-new-host-key'] }));

        expect(config.host_key_fingerprint).toBe(SERVER_FP);
      });

      // An offline edit never connects, so the guard has nothing to protect there.
      it('should not refuse an offline edit', async () => {
        const { io } = scriptIo({ interactive: false });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags({ ...cliInput({ rawArgs: flags }), offline: true });

        expect(config.host).toBe('sshhost');
      });

      // At a terminal the first connection asks the operator about the key.
      it('should not refuse when someone is at the terminal to confirm the key', async () => {
        const { io } = scriptIo({ interactive: true });
        const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

        const config = await p.configureFromFlags(cliInput({ rawArgs: flags }));

        expect(config.host).toBe('sshhost');
      });
    });
  });

  // --- validateConfig -------------------------------------------------------

  describe('validateConfig', () => {
    it('should return [] for a valid password config', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      expect(p.validateConfig({ host: 'ssh.example.com', port: 22, user: 'alice', password: 'secret', path: '/backup', auth_method: 'password' })).toEqual([]);
    });

    it('should return [] for a valid key config', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      expect(p.validateConfig({ host: 'ssh.example.com', port: 22, user: 'alice', private_key_path: '/keys/id_ed25519', path: '/backup', auth_method: 'key' })).toEqual([]);
    });

    it('should report a missing or empty host', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ port: 22, path: '/backup', auth_method: 'password', password: 'x' });
      expect(errors.some((e: string) => /host/i.test(e))).toBe(true);
    });

    it('should report a path that is not absolute', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'ssh.example.com', port: 22, path: 'backup', auth_method: 'password', password: 'x' });
      expect(errors.some((e: string) => /path/i.test(e))).toBe(true);
    });

    it('should report a config with no usable auth method', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'ssh.example.com', port: 22, path: '/backup' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // --- describeConfig -------------------------------------------------------

  describe('describeConfig', () => {
    it('should include host, port, user, and path', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ssh.example.com', port: 2222, user: 'alice', password: 'secret', path: '/backup', auth_method: 'password' });

      expect(desc).toContain('ssh.example.com');
      expect(desc).toContain('2222');
      expect(desc).toContain('alice');
      expect(desc).toContain('/backup');
    });

    it('should mask the password field - no plaintext, asterisks present', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ssh.example.com', port: 22, user: 'alice', password: 'supersecret', path: '/backup', auth_method: 'password' });

      expect(desc).not.toContain('supersecret');
      expect(desc).toMatch(/\*{3,}/);
    });

    it('should mask the passphrase field - no plaintext, asterisks present', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ssh.example.com', port: 22, user: 'alice', private_key_path: '/keys/id_ed25519', passphrase: 'topsecret', path: '/backup', auth_method: 'key' });

      expect(desc).not.toContain('topsecret');
      expect(desc).toMatch(/\*{3,}/);
      expect(desc).toContain('/keys/id_ed25519');
    });
  });

  // --- getSecretFields ------------------------------------------------------

  describe('getSecretFields', () => {
    it('should return ["password", "passphrase"]', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);
      expect(p.getSecretFields()).toEqual(['password', 'passphrase']);
    });
  });

  // --- probeConnection ------------------------------------------------------

  describe('probeConnection', () => {
    it('should upload, download, compare, and clean up - leaving no residue', async () => {
      await provider.probeConnection();

      const refs = await provider.list();
      expect(refs).toEqual([]);
    });

    it('should throw ProviderError when the SSH connection fails', async () => {
      mockState.connectShouldFail = true;
      await expect(provider.probeConnection()).rejects.toThrow(ProviderError);
    });
  });

  // --- verifyShard ----------------------------------------------------------

  describe('verifyShard', () => {
    const IDENTITY = { vault_id: '550e8400-e29b-41d4-a716-446655440000', shard_index: 0, version: 1 };

    it('should return ok for a matching shard identity', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader(), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result).toEqual({ ok: true });
    });

    it('should report not_found (SFTP code 2) for a missing shard', async () => {
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.999' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_found');
    });

    it('should report auth_failed when authentication is rejected', async () => {
      mockState.authShouldFail = true;
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('auth_failed');
    });

    it('should report unverifiable on a transport error with no recognized code', async () => {
      mockState.connectShouldFail = true;
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unverifiable');
    });

    it('should report mismatch on a wrong expected version', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader({ version: 1 }), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, { ...IDENTITY, version: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('mismatch');
        expect(result.detail).toContain('version');
      }
    });

    it('should report corrupted for a truncated shard', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', Buffer.alloc(8));
      const result = await provider.verifyShard({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('corrupted');
    });
  });

  // --- host-key verification (TOFU + known_hosts, CI gate) -------------------
  //
  // GUESSED API surfaced in the report:
  //  - The provider builds `cfg.hostVerifier(key, cb)`; cb(true) trusts, cb(false)
  //    rejects. A rejection makes connect emit an error; withClient surfaces a
  //    host-key mismatch (pin set, presented fp !== pin) as TamperDetectedError -
  //    a precise MITM signal uniform with FTP - and every other host-key refusal
  //    (@revoked, TOFU decline) as ProviderError/HostKeyDeclinedError.
  //  - Precedence: a pinned `host_key_fingerprint` in config wins; otherwise
  //    `~/.ssh/known_hosts` is consulted; otherwise TOFU (io.confirm) interactively,
  //    or the `--accept-new-host-key` / `--known-host` flags in non-interactive mode.
  //  - The TOFU confirm prompt text includes the SHA256 fingerprint.
  describe('host-key verification', () => {
    it('should connect silently when the pinned fingerprint matches the server key', async () => {
      const { io, calls } = scriptIo({ confirm: () => false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });

    // NEW CONTRACT (RED until GREEN): a pin that does not match the presented key
    // is a host-key mismatch, not a generic transport failure. It must surface as
    // TamperDetectedError (a precise MITM signal uniform with FTP) instead of being
    // wrapped in a generic ProviderError by withClient. TamperDetectedError extends
    // BfsError (NOT ProviderError), so asserting it also proves the error is no
    // longer swallowed as a plain ProviderError.
    it('should surface TamperDetectedError when the pinned fingerprint does not match the server key', async () => {
      const { io } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: 'SHA256:deadbeefdeadbeefdeadbeefdeadbeef' }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(TamperDetectedError);
    });

    // NEW CONTRACT (RED until GREEN): the classic MITM - a valid pin is configured,
    // but an impostor at the same address answers the handshake with a DIFFERENT
    // host key (fp !== pin). This is exactly what the pin exists to catch, so the
    // rejection must be TamperDetectedError, not a generic ProviderError.
    it('should surface TamperDetectedError when the presented host key differs from the pin', async () => {
      const { io } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      // A valid pin is configured, but the server presents an impostor key.
      mockState.hostKey = Buffer.from('impostor-ssh-host-key');

      await expect(p.authenticate()).rejects.toThrow(TamperDetectedError);
    });

    it('should prompt on a new host (TOFU) and connect after the operator accepts', async () => {
      const { io, calls } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      const confirmCall = calls.find((c) => c.kind === 'confirm');
      expect(confirmCall).toBeDefined();
      expect(confirmCall?.text).toContain(SERVER_FP);
    });

    it('should refuse a new host when the operator declines the fingerprint', async () => {
      const { io, calls } = scriptIo({ confirm: () => false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(true);
    });

    it('should trust a host present in ~/.ssh/known_hosts without prompting', async () => {
      const home = await makeTempHome();
      // known_hosts line: "<host> <keytype> <base64 of the wire host key>".
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const { io, calls } = scriptIo({ confirm: () => false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });

    // The pin in config.json is authoritative for trust: a wrong pin refuses even
    // when ~/.ssh/known_hosts holds the correct key as a (non-revoked) trusted
    // line. Only an @revoked entry overrides a pin - see the hardening block.
    it('should let a config pin override known_hosts (pin authoritative)', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const { io } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: 'SHA256:deadbeefdeadbeefdeadbeefdeadbeef' }), io);
      p.setVaultName('testvault');

      // Pin is authoritative but does not match the presented key -> host-key
      // mismatch, which surfaces as TamperDetectedError under the new contract.
      await expect(p.authenticate()).rejects.toThrow(TamperDetectedError);
    });

    it('should refuse a new host in non-interactive mode without --accept-new-host-key', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);

      // The refusal that follows this (raised by ssh2's verifier -> withClient)
      // is a generic transport error naming neither flag - decideHostKeyTrust
      // must surface the way out itself, the same way it already does for
      // @revoked (ssh_host_key_revoked), instead of leaving the operator with
      // only "SSH operation failed".
      const warning = calls.find((c) => c.kind === 'warn');
      expect(warning).toBeDefined();
      expect(warning?.text).toContain('--accept-new-host-key');
      expect(warning?.text).toContain('--known-host');
    });

    // A stored `accept_new_host_key: true` without a pin is consent read back from
    // disk, so it would be spent again on every run - any key at that address
    // would be trusted forever. Without an operator it must refuse. The warning
    // names the storage target and the state only: no flag (the runtime adapter
    // cannot see the command's flags, and naming the opt-in would send the
    // operator in a circle), no command, and never the fingerprint the server
    // presented - pasting that without out-of-band verification would pin an
    // active MITM for good.
    it('should refuse a stored accept_new_host_key without a pin when nobody can confirm', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      const warnings = calls.filter((c) => c.kind === 'warn').map((c) => c.text);
      // Target AND state in one warning: a generic decline or transport message
      // naming the target alone must not satisfy this.
      expect(warnings.some((w) => w.includes('sshuser@sshhost:22') && w.includes('not pinned'))).toBe(true);
      for (const w of warnings) {
        expect(w).not.toContain('--accept-new-host-key');
        expect(w).not.toContain('--known-host');
        expect(w).not.toContain('provider edit');
        expect(w).not.toContain(SERVER_FP);
      }
    });

    // Same refusal in Polish - the opt-in is not named and no fix is suggested.
    it('should refuse a stored accept_new_host_key without a pin for a Polish operator without suggesting a fix', async () => {
      const { io, calls } = scriptIo({ interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), { ...io, lang: 'pl' });
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      const warnings = calls.filter((c) => c.kind === 'warn').map((c) => c.text);
      expect(warnings.some((w) => w.includes('sshuser@sshhost:22') && w.includes('nie jest przypięt'))).toBe(true);
      for (const w of warnings) {
        expect(w).not.toContain('--accept-new-host-key');
        expect(w).not.toContain('--known-host');
        expect(w).not.toContain('provider edit');
        expect(w).not.toContain(SERVER_FP);
      }
    });

    it('should accept in non-interactive mode when the fingerprint was pinned via --known-host', async () => {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
    });

    // With an operator present a stored opt-in without a pin is not consent
    // either: the operator is asked. A refusal ends in a refusal.
    it('should ask the operator about a stored accept_new_host_key without a pin and refuse when declined', async () => {
      const { io, calls } = scriptIo({ confirm: () => false, interactive: true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    it('should ask the operator about a stored accept_new_host_key without a pin and connect after consent', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    // The answer lasts one command: `providerRegistry.create` builds a new
    // instance per part and `bfs verify` connects once per part and version, so a
    // per-instance field would ask again and again. It is keyed by the command's
    // io - a new command (new io) asks again, since in the REPL the process lives
    // for days and a consent from one push must not carry over to the next.
    it('should ask once per command for the same target across instances sharing one io', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const first = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      const second = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      first.setVaultName('testvault');
      second.setVaultName('testvault');

      await first.authenticate();
      await second.authenticate();

      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    // A refusal is remembered for the command as well: on push the collision
    // guard connects first and swallows its error, then openProviders connects
    // again - without this the operator would be asked the same question twice.
    it('should remember a refusal for the command and not ask again for the same target', async () => {
      const { io, calls } = scriptIo({ confirm: () => false, interactive: true });
      const first = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      const second = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      first.setVaultName('testvault');
      second.setVaultName('testvault');

      await expect(first.authenticate()).rejects.toThrow(ProviderError);
      await expect(second.authenticate()).rejects.toThrow(ProviderError);

      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    // The remembered consent is for the fingerprint the operator was shown, not
    // for whatever the target presents later in the same command: a key that
    // changes between connections (an active MITM, servers behind a balancer)
    // must not ride on the earlier answer.
    it('should not let a consent for one key cover a different key at the same target in the same command', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const first = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      const second = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      first.setVaultName('testvault');
      second.setVaultName('testvault');

      await first.authenticate();
      mockState.hostKey = Buffer.from('another-ssh-host-key');
      await second.authenticate();

      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(2);
    });

    // One command can hand adapters two io objects: recovery wraps the command's
    // io in a spinner io (a spread copy with the prompts re-routed). Both belong
    // to the same command, so an answer given through one is remembered for the
    // other - otherwise an attended recovery asks the same question twice.
    it('should remember the answer across the command io and its spinner wrapper', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const spinner = { isSpinning: false, text: '', stop() {}, start() {} } as unknown as Ora;
      const wrapped = createSpinnerIo(io, spinner);
      const first = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      const second = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), wrapped);
      first.setVaultName('testvault');
      second.setVaultName('testvault');

      await first.authenticate();
      await second.authenticate();

      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    it('should ask again in the next command (a new io) for the same target', async () => {
      const { io: io1, calls: calls1 } = scriptIo({ confirm: () => true, interactive: true });
      const { io: io2, calls: calls2 } = scriptIo({ confirm: () => true, interactive: true });
      const first = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io1);
      const second = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io2);
      first.setVaultName('testvault');
      second.setVaultName('testvault');

      await first.authenticate();
      await second.authenticate();

      expect(calls1.filter((c) => c.kind === 'confirm')).toHaveLength(1);
      expect(calls2.filter((c) => c.kind === 'confirm')).toHaveLength(1);
    });

    // The remembered answer is keyed by the target as well: consent for host A
    // must not let an unknown key on host B through within the same command.
    it('should not let a consent for one target cover another target in the same command', async () => {
      const answers = [true, false];
      const { io, calls } = scriptIo({ confirm: () => answers.shift() ?? false, interactive: true });
      const hostA = new SshProvider(makeConfig({ host: 'sshhost', host_key_fingerprint: null, accept_new_host_key: true }), io);
      const hostB = new SshProvider(makeConfig({ host: 'otherhost', host_key_fingerprint: null, accept_new_host_key: true }), io);
      hostA.setVaultName('testvault');
      hostB.setVaultName('testvault');

      await expect(hostA.authenticate()).resolves.toBeUndefined();
      await expect(hostB.authenticate()).rejects.toThrow(ProviderError);

      expect(calls.filter((c) => c.kind === 'confirm')).toHaveLength(2);
    });

    // Positive controls: known_hosts and a matching pin are consulted before the
    // opt-in rung, so a config carrying the pair still connects silently when
    // either vouches for the key. Without these an implementation refusing on the
    // config alone - before the socket - would pass the whole block.
    it('should connect silently despite a stored accept_new_host_key when the host is in ~/.ssh/known_hosts', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;
      const { io, calls } = scriptIo({ confirm: () => false, interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm' || c.kind === 'warn')).toBe(false);
    });

    it('should connect silently despite a stored accept_new_host_key when the pin matches', async () => {
      const { io, calls } = scriptIo({ confirm: () => false, interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm' || c.kind === 'warn')).toBe(false);
    });

    // Guard for the order above: revocation is checked FIRST and beats every
    // source of trust (fail-closed), the opt-in included. Every host-key refusal
    // surfaces the same ProviderError, so the reason is asserted through the warn
    // entry - without it this passes even if the revocation notice is dropped.
    it('should still refuse an @revoked key when accept_new_host_key is set on a terminal', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'warn' && c.text.includes('revoked'))).toBe(true);
    });

    // Guard for the other end of the ladder: the pin stays authoritative. The
    // opt-in and a pin travel together in every config the flag produces (and in
    // every SSH provider the e2e harness builds), so an opt-in check placed above
    // the pin would silently switch host-key MITM detection off for all of them.
    it('should still refuse a mismatched pin when accept_new_host_key is set on a terminal', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      mockState.hostKey = Buffer.from('impostor-ssh-host-key');

      await expect(p.authenticate()).rejects.toThrow(TamperDetectedError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });
  });

  // --- H1: --accept-new-host-key must PIN (real TOFU), not trust every time --
  //
  // Regression guard for a MITM window: `--accept-new-host-key` on a
  // non-interactive `provider add`/`init` (no `--known-host`) must capture the
  // host key on first contact and PIN its fingerprint into the config - the
  // OpenSSH `accept-new` semantics the flag name implies. Trusting whatever key
  // is presented on EVERY later connection ("accept every time") leaves a
  // permanent MITM window: an impostor at the same address intercepts the
  // password and all push/pull traffic. Do not delete these without replacing
  // the pinning guarantee they encode.
  describe('host-key pinning on --accept-new-host-key (H1)', () => {
    it('should pin the presented fingerprint when --accept-new-host-key is given without --known-host', async () => {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--accept-new-host-key'] }));

      // The key seen at first contact must travel with the backup as a pin, so
      // the pinned-fingerprint path (fp === pin) guards every later connection.
      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    it('should refuse a later connection whose host key differs from the one pinned at --accept-new-host-key time', async () => {
      // First contact pins K1.
      const { io } = scriptIo({ interactive: false });
      const stub = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);
      const config = await stub.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--accept-new-host-key'] }));

      // A later push/pull uses a provider built from that persisted config.
      const { io: io2 } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config }, io2);
      p.setVaultName('testvault');

      // An impostor now answers at the same address with a DIFFERENT host key.
      mockState.hostKey = Buffer.from('impostor-ssh-host-key');

      // Presented impostor key differs from the pinned fp -> host-key mismatch ->
      // TamperDetectedError under the new contract.
      await expect(p.authenticate()).rejects.toThrow(TamperDetectedError);
    });

    // Guard: once a pin exists, --accept-new-host-key is a no-op - it must NOT
    // recapture and overwrite the authoritative pin with whatever key the server
    // now presents. (The counterpart - a mismatched key being refused against an
    // existing pin - is already covered by "should surface TamperDetectedError
    // when the pinned fingerprint does not match the server key" in the host-key
    // verification block; not duplicated here.)
    it('should NOT overwrite an existing --known-host pin when --accept-new-host-key is also given', async () => {
      const EXISTING_PIN = 'SHA256:existingpinexistingpinexistingpinexistingpin';
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--known-host', EXISTING_PIN, '--accept-new-host-key'] }));

      expect(config.host_key_fingerprint).toBe(EXISTING_PIN);
    });

    // The capture must not depend on whether anyone is watching. `bfs repair` and
    // `bfs provider remove --strategy` forward the adapter flags with an
    // INTERACTIVE io (neither requires --ci) and persist what comes back.
    // Capturing only off a terminal therefore leaves those runs writing
    // `accept_new_host_key: true` with a null pin - the standing "trust any key at
    // this address, every connection" window this block exists to close.
    it('should pin the presented fingerprint on a terminal too when --accept-new-host-key is given', async () => {
      // Both forms of the question answer "no": a yes/no refuses and a menu
      // cancels, so a flow that asks either way fails instead of pinning.
      const { io, calls } = scriptIo({ interactive: true, confirm: () => false, choose: (_m, o) => (isTrustMenu(o) ? fmtFor('en', 'trust_choice_cancel') : (o[0] ?? '')) });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--accept-new-host-key'] }));

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
      // Silently: the flag already carries the operator's answer.
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'choose')).toBe(false);
    });

    // Counterpart of the non-interactive guard above. Worth knowing when reading
    // a green run: it only tells "an explicit pin survives" as long as the
    // capture fires on this path at all - with no capture there would be nothing
    // to overwrite and it would pass vacuously.
    it('should NOT overwrite an existing --known-host pin on a terminal either', async () => {
      const EXISTING_PIN = 'SHA256:existingpinexistingpinexistingpinexistingpin';
      const { io } = scriptIo({ interactive: true });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--known-host', EXISTING_PIN, '--accept-new-host-key'] }));

      expect(config.host_key_fingerprint).toBe(EXISTING_PIN);
    });
  });

  // --- --accept-new-host-key on an offline edit: the refusal names the conflict -
  //
  // `bfs provider edit --ci` never contacts the medium, so it cannot capture a
  // new host key and refuses the flag. The refusal says what clashes - the flag
  // needs a connection, the command makes none - and stops there. It does not
  // guess a way out: whether the key changed because the server was reinstalled
  // or because something else answers at that address is the operator's call,
  // and a recipe that fits one case leads the other into a dead end (an
  // interactive edit on an unchanged address keeps the old pin; `provider add`
  // adds another storage instead of fixing this one).
  describe('offline edit refusing --accept-new-host-key', () => {
    const OFFLINE_EDIT_ARGS = ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--accept-new-host-key'];

    async function offlineRefusal(lang: string): Promise<string> {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'ssh1', type: 'ssh', adapterPackage: null, config: {} }, { ...io, lang });
      const refusal = p.configureFromFlags({ ...cliInput({ name: 'ssh1', rawArgs: OFFLINE_EDIT_ARGS }), offline: true });
      await expect(refusal).rejects.toThrow(ProviderError);
      return refusal.then(
        () => '',
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
    }

    it('should name the flag and the offline command without suggesting a fix', async () => {
      const message = await offlineRefusal('en');

      expect(message).toContain('--accept-new-host-key');
      expect(message).toContain('bfs provider edit --ci');
      expect(message).not.toContain('--known-host');
      expect(message).not.toContain('provider add');
    });

    it('should name the same conflict to a Polish operator without suggesting a fix', async () => {
      const message = await offlineRefusal('pl');

      expect(message).toContain('--accept-new-host-key wymaga');
      expect(message).toContain('bfs provider edit --ci');
      expect(message).not.toContain('--known-host');
      expect(message).not.toContain('provider add');
    });
  });

  // --- M1: per-operation SFTP idle timeout (DoS) ---------------------------
  //
  // A malicious or hung-but-alive SSH server completes the handshake (so `ready`
  // fires, passing readyTimeout) then never answers an SFTP request. Without a
  // per-operation idle timeout the operation - and the whole CLI command - hangs
  // forever. FTP survives this via basic-ftp's 10s socket timeout; SSH must match
  // with an idle timeout reset on each received payload. Fake timers make the wait
  // instant: after advancing past the idle window the op must have REJECTED; while
  // it still hangs (no timeout) the outcome stays 'pending'. Do not delete without
  // preserving the no-hang guarantee.
  describe('SFTP operation idle timeout (M1)', () => {
    // Must equal SFTP_IDLE_TIMEOUT_MS in src/providers/ssh.ts (FTP parity: 10s).
    const IDLE_MS = 10_000;

    // Every connection's host-key check reads ~/.ssh/known_hosts. A real
    // fs.readFile is a libuv thread-pool macrotask that does NOT settle under
    // fake timers, so the handshake would never reach `ready` and the idle timer
    // under test would never be armed. Resolve the (absent - homeDir points at a
    // non-existent dir) read as a microtask-queue rejection so the handshake
    // completes deterministically; the idle-timeout behavior asserted below is
    // untouched.
    beforeEach(() => {
      vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('ENOENT: no known_hosts'), { code: 'ENOENT' }));
    });

    async function outcomeAfterIdle(op: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void op.then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        },
      );
      await vi.advanceTimersByTimeAsync(IDLE_MS + 1000);
      return outcome;
    }

    it('should reject a metadata op that stalls after ready, instead of hanging', async () => {
      vi.useFakeTimers();
      try {
        const { io } = createMockProviderIO();
        const p = new SshProvider(makeConfig(), io);
        p.setVaultName('testvault');
        mockState.sftpHang = true; // server answers the handshake, then goes silent on readdir

        const outcome = await outcomeAfterIdle(p.authenticate());

        expect(outcome).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should reject a download whose read stream stalls after ready, instead of hanging', async () => {
      vi.useFakeTimers();
      try {
        const { io } = createMockProviderIO();
        const p = new SshProvider(makeConfig(), io);
        p.setVaultName('testvault');
        mockState.sftpHang = true; // the read stream opens but never delivers a byte

        const outcome = await outcomeAfterIdle(p.download({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }));

        expect(outcome).toBe('rejected');
      } finally {
        vi.useRealTimers();
      }
    });

    // The idle timeout must RESET on each received payload - a slow-but-
    // progressing transfer completes, only a genuine stall fails. 4 chunks 8s
    // apart (< the 10s idle window) total 32s: a correct idle timeout resolves;
    // a WRONG total-operation timeout would cut it at 10s. Guards against
    // regressing "idle" to "total" (which would sever legitimately slow large
    // shards over a slow link).
    it('should NOT time out a slow-but-progressing transfer (idle resets on each payload)', async () => {
      vi.useFakeTimers();
      try {
        const { io } = createMockProviderIO();
        const p = new SshProvider(makeConfig(), io);
        p.setVaultName('testvault');
        mockState.streamChunkDelayMs = 8_000; // < IDLE_MS, so each chunk resets the idle timer
        mockState.streamChunks = 4; // total 32s > IDLE_MS

        let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
        const op = p.download({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' }).then(
          () => {
            outcome = 'resolved';
          },
          () => {
            outcome = 'rejected';
          },
        );
        await vi.advanceTimersByTimeAsync(4 * 8_000 + 2_000);
        await op;

        expect(outcome).toBe('resolved');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- hardening (L1 revoked host key, L2 path traversal, L4 auth conflict, L6 idempotent delete) ---
  describe('hardening', () => {
    // L1 - an @revoked entry in ~/.ssh/known_hosts marks the key compromised; it
    // must HARD-REFUSE, never fall through to a TOFU confirm that could accept the
    // revoked key.
    it('should hard-refuse a host key marked @revoked in known_hosts', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const { io, calls } = scriptIo({ confirm: () => true }); // even if the operator would say yes
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false); // revoked = hard refuse, no prompt
    });

    // A key revoked in ~/.ssh/known_hosts is compromised and must be hard-refused
    // even when its fingerprint is PINNED in the provider config. Revocation from
    // any source wins over trust (fail-closed) - the pin alone must not authorize
    // a connection the operator marked @revoked. The refusal surfaces the reason
    // (revoked) so the operator understands why, not a generic transport failure.
    it('should hard-refuse a @revoked host key even when the fingerprint is pinned', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      // Pin equals the presented key's fingerprint. Revocation is checked before
      // the pin, so a pinned-but-revoked key is refused (fail-closed) - the pin
      // alone does not authorize a connection the operator marked @revoked.
      const { io, calls } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false); // hard refuse, no prompt
      expect(calls.some((c) => c.kind === 'warn' && /revoked/i.test(c.text))).toBe(true); // reason surfaced
    });

    // L2 - a ref.path with a traversal segment must be rejected before it is
    // joined into the remote path, so a crafted filename cannot escape the vault.
    it('should reject a download whose ref.path contains a traversal segment', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider(makeConfig(), io);
      p.setVaultName('testvault');

      await expect(p.download({ provider_id: 'test-ssh', path: '../../evil' })).rejects.toThrow(UnsafePathError);
    });

    it('should reject a delete whose ref.path contains a traversal segment', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider(makeConfig(), io);
      p.setVaultName('testvault');

      await expect(p.delete({ provider_id: 'test-ssh', path: '../evil' })).rejects.toThrow(UnsafePathError);
    });

    // L4 - validateConfig must reject a config carrying BOTH a password and a key,
    // matching configureFromFlags (which throws ssh_auth_conflict). A hand-edited
    // config with both must not silently validate.
    it('should reject a config that carries both a password and a private key', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'h', port: 22, path: '/b', auth_method: 'password', password: 'p', private_key_path: '/k' });

      expect(errors.length).toBeGreaterThan(0);
    });

    // L6 - delete must be idempotent: an already-absent shard is success, not a
    // throw. Otherwise prune emits a false "possible orphan" warning for data that
    // is already gone.
    it('should treat deleting an already-absent shard as success (idempotent)', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider(makeConfig(), io);
      p.setVaultName('testvault');

      // shard_9.bfs.1 was never uploaded -> absent from the mock filesystem.
      await expect(p.delete({ provider_id: 'test-ssh', path: 'shard_9.bfs.1' })).resolves.toBeUndefined();
    });

    // F1 - delete removes the header sidecar together with the shard, so prune
    // (which calls delete) leaves no orphaned hdr_ file behind on the medium.
    it('should remove the header sidecar together with the shard on delete', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider(makeConfig(), io);
      p.setVaultName('testvault');
      mockState.files.set('/backup/testvault/shard_0.bfs.1', Buffer.from('shard'));
      mockState.files.set('/backup/testvault/hdr_0.bfs.1', Buffer.from('hdr'));

      await p.delete({ provider_id: 'test-ssh', path: 'shard_0.bfs.1' });

      expect(mockState.files.has('/backup/testvault/shard_0.bfs.1')).toBe(false);
      expect(mockState.files.has('/backup/testvault/hdr_0.bfs.1')).toBe(false);
    });
  });

  // --- auth-defaults (~/.ssh key discovery) ---------------------------------

  describe('auth defaults', () => {
    it('should default to the ~/.ssh/id_ed25519 key when no credential flag is given', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE-KEY', 'utf8');
      mockState.homeDir = home;

      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b'] }));

      expect(config).toMatchObject({ auth_method: 'key', private_key_path: path.join(home, '.ssh', 'id_ed25519') });
    });

    it('should prefer id_ed25519 over id_rsa when both exist', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), 'ED', 'utf8');
      await fs.writeFile(path.join(home, '.ssh', 'id_rsa'), 'RSA', 'utf8');
      mockState.homeDir = home;

      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b'] }));

      expect(config.private_key_path).toBe(path.join(home, '.ssh', 'id_ed25519'));
    });

    it('should fall back to id_rsa when id_ed25519 is absent', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'id_rsa'), 'RSA', 'utf8');
      mockState.homeDir = home;

      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--user', 'u', '--path', '/b'] }));

      expect(config.private_key_path).toBe(path.join(home, '.ssh', 'id_rsa'));
    });

    it('should load login/password from --config-file', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'h', port: 22, user: 'alice', password: 'from-file', path: '/b' }));
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config).toMatchObject({ auth_method: 'password', user: 'alice', password: 'from-file' });
    });
  });

  // --- connectForRecovery (anti-phishing: show host BEFORE the secret) -------

  describe('connectForRecovery', () => {
    type WithRecovery = SshProvider & { connectForRecovery(io: ProviderIO, pool: readonly RecoverySecret[], options?: { trustLocation?: boolean }): Promise<Nullable<string>> };

    it('should show user@host:port before collecting the password, then return the typed secret', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw' });
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const returned = await sshProvider.connectForRecovery(io, []);

      const askIndex = calls.findIndex((c) => c.kind === 'askSecret');
      const hostIndex = calls.findIndex((c) => c.text.includes('sshhost'));
      expect(hostIndex).toBeGreaterThanOrEqual(0);
      expect(askIndex).toBeGreaterThanOrEqual(0);
      expect(hostIndex).toBeLessThan(askIndex);
      // The pinned host-key fingerprint is also surfaced before the secret is collected.
      const fingerprintShownBeforeSecret = calls.slice(0, askIndex).some((c) => c.text.includes(SERVER_FP));
      expect(fingerprintShownBeforeSecret).toBe(true);
      expect(returned).toBe('victim-pw');
    });

    it('should refuse and collect no secret when the operator declines the host', async () => {
      let askSecretCalled = false;
      const { io } = scriptIo({
        confirm: () => false,
        askSecret: () => {
          askSecretCalled = true;
          return 'never-collected';
        },
      });
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      await expect(sshProvider.connectForRecovery(io, [])).rejects.toBeInstanceOf(ProviderError);
      expect(askSecretCalled).toBe(false);
    });

    it('should recover a passphrase-protected key by collecting the passphrase (routed to the key), host shown first', async () => {
      const home = await makeTempHome();
      const keyPath = path.join(home, '.ssh', 'id_ed25519');
      await fs.writeFile(keyPath, 'PRIVATE-KEY', 'utf8');
      mockState.keyPassphrase = 'secret-phrase';
      const { io, calls } = scriptIo({ confirm: () => true, askSecret: () => 'secret-phrase' });
      const sshProvider = new SshProvider(makeConfig({ auth_method: 'key', private_key_path: keyPath, host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const returned = await sshProvider.connectForRecovery(io, []);

      const askIndex = calls.findIndex((c) => c.kind === 'askSecret');
      const hostIndex = calls.findIndex((c) => c.text.includes('sshhost'));
      expect(hostIndex).toBeGreaterThanOrEqual(0);
      expect(askIndex).toBeGreaterThanOrEqual(0);
      expect(hostIndex).toBeLessThan(askIndex);
      expect(returned).toBe('secret-phrase');
    });

    it('should return null for an unencrypted key (no secret needed) after confirming the host', async () => {
      const home = await makeTempHome();
      const keyPath = path.join(home, '.ssh', 'id_ed25519');
      await fs.writeFile(keyPath, 'PRIVATE-KEY', 'utf8');
      const { io, calls } = scriptIo({ confirm: () => true, askSecret: () => 'never' });
      const sshProvider = new SshProvider(makeConfig({ auth_method: 'key', private_key_path: keyPath, host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const returned = await sshProvider.connectForRecovery(io, []);

      expect(returned).toBeNull();
      expect(calls.some((c) => c.kind === 'askSecret')).toBe(false);
    });

    // Transport failure != rejected secret. A "connection lost before the
    // handshake" is a code-less/level-less transport error (wrapped as a
    // ProviderError), not an authentication rejection. In a NON-interactive
    // recovery (io.interactive === false) there is no operator to answer, so
    // connectForRecovery must never fall through to io.askSecret - it must
    // surface the transport failure instead of silently mistaking it for a
    // wrong secret and prompting into a closed stdin.
    it('should NOT prompt for a secret in non-interactive recovery when the connection fails with a transport error', async () => {
      let askSecretCalled = false;
      const { io } = scriptIo({
        interactive: false,
        askSecret: () => {
          askSecretCalled = true;
          return '';
        },
      });
      // Connect cannot be established at all -> code-less, level-less error ->
      // wrapped as a transport ProviderError (NOT level 'client-authentication').
      mockState.connectShouldFail = true;
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      // A pooled secret is present (as in a seeded, unattended --trust-locations
      // recovery); trustLocation:true skips the interactive host confirmation so
      // control reaches the pool/prompt logic.
      const pool: RecoverySecret[] = [{ value: 'pooled-pw', origin: 'bootstrap' }];
      await sshProvider.connectForRecovery(io, pool, { trustLocation: true }).catch(() => undefined);

      expect(askSecretCalled).toBe(false);
    });

    // Transport failure != rejected secret, in INTERACTIVE mode too. A pooled
    // secret is present but the host is unreachable: the transport failure must
    // surface (reject) rather than be mistaken for a wrong secret and drive an
    // endless password re-prompt. Guards the classification, not just the
    // non-interactive guard.
    it('should surface a transport failure during interactive recovery instead of re-prompting', async () => {
      const { io, calls } = scriptIo({ interactive: true });
      mockState.connectShouldFail = true;
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const pool: RecoverySecret[] = [{ value: 'pooled-pw', origin: 'bootstrap' }];
      await expect(sshProvider.connectForRecovery(io, pool, { trustLocation: true })).rejects.toThrow(ProviderError);

      expect(calls.some((c) => c.kind === 'askSecret')).toBe(false);
    });

    // A REJECTED credential (ssh2 level 'client-authentication') IS distinct from
    // a transport failure: a wrong pooled secret must fall through to the
    // interactive prompt (here the operator declines with a blank secret). This
    // is the counterpart to the transport case above - together they prove the
    // transport-vs-auth classification, not just "never prompts".
    it('should fall through to the interactive prompt when a pooled secret is rejected', async () => {
      const { io, calls } = scriptIo({ interactive: true, askSecret: () => '' });
      mockState.authShouldFail = true;
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim' }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const pool: RecoverySecret[] = [{ value: 'wrong-pw', origin: 'bootstrap' }];
      await expect(sshProvider.connectForRecovery(io, pool, { trustLocation: true })).rejects.toThrow(ProviderError);

      expect(calls.some((c) => c.kind === 'askSecret')).toBe(true);
    });

    // Unattended recovery (--trust-locations) of a storage whose location map
    // carries a bare `accept_new_host_key: true`: the host-key ladder refuses,
    // and the refusal must reach the operator as what it is - an unpinned server
    // identity named by its target. Bootstrap turns the throw into a silent skip,
    // so the reason has to be spoken through warn() first.
    it('should refuse a stored accept_new_host_key without a pin in unattended recovery as an identity refusal, not a wrong secret', async () => {
      const { io, calls } = scriptIo({ interactive: false });
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: null, accept_new_host_key: true }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');
      const pool: RecoverySecret[] = [{ value: 'sshpass', origin: 'bootstrap' }];

      const outcome = sshProvider.connectForRecovery(io, pool, { trustLocation: true });

      await expect(outcome).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'askSecret' || c.kind === 'confirm')).toBe(false);
      const warnings = calls.filter((c) => c.kind === 'warn').map((c) => c.text);
      expect(warnings.some((w) => w.includes('victim@sshhost:2222') && w.includes('not pinned'))).toBe(true);
      for (const w of warnings) {
        expect(w).not.toContain('--accept-new-host-key');
        expect(w).not.toContain('--known-host');
        expect(w).not.toContain(SERVER_FP);
      }
    });

    // An attended recovery that confirmed the host key hands its fingerprint
    // back through takeConfigUpdates, so the core writes it into the config.json
    // it creates - that run is the one producing the configuration, so the
    // operator's decision is consent from this invocation, not a stored opt-in.
    // The next unattended command then connects on the pin without asking.
    it('should hand the confirmed fingerprint back after an attended recovery, so the next unattended command connects on it', async () => {
      const { io } = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw', interactive: true });
      const stored = { host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: null, accept_new_host_key: true };
      const sshProvider = new SshProvider(makeConfig(stored), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      await sshProvider.connectForRecovery(io, []);
      const updates = takeUpdates(sshProvider);

      expect(updates).toEqual({ host_key_fingerprint: SERVER_FP });
      const { io: unattendedIo, calls } = scriptIo({ confirm: () => false, interactive: false });
      const next = new SshProvider(makeConfig({ ...stored, ...(updates as Record<string, unknown>) }), unattendedIo);
      next.setVaultName('testvault');
      await expect(next.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm' || c.kind === 'warn')).toBe(false);
    });

    // A/B against the password case above: a key without a passphrase makes
    // connectForRecovery return no secret at all, and the fingerprint must still
    // go back - the update is about the server, not about the credential.
    it('should hand the confirmed fingerprint back when the recovery needed no secret (key without a passphrase)', async () => {
      const home = await makeTempHome();
      const keyPath = path.join(home, '.ssh', 'id_ed25519');
      await fs.writeFile(keyPath, 'PRIVATE-KEY', 'utf8');
      const { io } = scriptIo({ confirm: () => true, askSecret: () => 'never', interactive: true });
      const sshProvider = new SshProvider(makeConfig({ auth_method: 'key', private_key_path: keyPath, host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: null, accept_new_host_key: true }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      const returned = await sshProvider.connectForRecovery(io, []);

      expect(returned).toBeNull();
      expect(takeUpdates(sshProvider)).toEqual({ host_key_fingerprint: SERVER_FP });
    });

    // The question may have been answered earlier in the same command, on another
    // instance; the instance that then hits the remembered answer must still hand
    // the fingerprint back - the decision is the operator's from this command
    // either way. This is why the remembered answer holds the fingerprint.
    // The question count proves the instance really hit the remembered answer:
    // a recovery alone asks `alone` questions (the host gate plus the key), the
    // same recovery after an earlier consent must ask exactly one fewer.
    it('should hand the fingerprint back from an instance that hit an answer given earlier in the same command', async () => {
      const stored = { host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: null, accept_new_host_key: true };
      const solo = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw', interactive: true });
      const soloProvider = new SshProvider(makeConfig(stored), solo.io) as WithRecovery;
      soloProvider.setVaultName('testvault');
      await soloProvider.connectForRecovery(solo.io, []);
      const alone = solo.calls.filter((c) => c.kind === 'confirm').length;
      const { io, calls } = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw', interactive: true });
      const earlier = new SshProvider(makeConfig(stored), io);
      const recovering = new SshProvider(makeConfig(stored), io) as WithRecovery;
      earlier.setVaultName('testvault');
      recovering.setVaultName('testvault');
      await earlier.authenticate();
      const askedBefore = calls.filter((c) => c.kind === 'confirm').length;

      await recovering.connectForRecovery(io, []);

      expect(askedBefore).toBe(1);
      expect(calls.filter((c) => c.kind === 'confirm').length - askedBefore).toBe(alone - 1);
      expect(takeUpdates(recovering)).toEqual({ host_key_fingerprint: SERVER_FP });
    });

    // Nothing was decided for a pinned host or one vouched for by known_hosts,
    // so nothing goes back.
    it('should hand nothing back when the host key was already pinned', async () => {
      const { io } = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw', interactive: true });
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: SERVER_FP, accept_new_host_key: true }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      await sshProvider.connectForRecovery(io, []);

      expect(takeUpdates(sshProvider)).toBeNull();
    });

    it('should hand nothing back when the host is in ~/.ssh/known_hosts', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `[sshhost]:2222 ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;
      const { io } = scriptIo({ confirm: () => true, askSecret: () => 'victim-pw', interactive: true });
      const sshProvider = new SshProvider(makeConfig({ host: 'sshhost', port: 2222, user: 'victim', host_key_fingerprint: null, accept_new_host_key: true }), io) as WithRecovery;
      sshProvider.setVaultName('testvault');

      await sshProvider.connectForRecovery(io, []);

      expect(takeUpdates(sshProvider)).toBeNull();
    });
  });

  // --- configureInteractiveForEdit (offline-first host-key handling) ---------
  //
  // `bfs provider edit <ssh>` must keep the offline-edit contract while still
  // handling host-key trust intelligently:
  //   (1) host AND port unchanged with a fingerprint already pinned -> reuse the
  //       pin WITHOUT contacting the server;
  //   (2) identity changed (host/port) or no old pin AND the server unreachable ->
  //       drop into an OFFLINE MENU (io.choose: use known_hosts / paste / back /
  //       leave unset / exit) instead of failing;
  //   (3) identity changed AND the server reachable -> the host-key menu (trust /
  //       back / cancel); cancel (or an @revoked key) aborts with
  //       HostKeyDeclinedError, back collects the fields again.
  describe('configureInteractiveForEdit', () => {
    const EXIST_HOST = 'sshhost';
    const NEW_HOST = 'newsshhost';
    const EDIT_USER = 'sshuser';
    const OLD_PIN = 'SHA256:oldpinoldpinoldpinoldpinoldpinoldpinoldp';
    const PASTED_FP = sshFingerprint(Buffer.from('operator-pasted-host-key'));

    /** Answers the SSH field prompts (host/port/user/path); '' otherwise. The
     * key/private branch is checked first because the private-key prompt text
     * contains both "key" and "path". */
    function fieldAsk(fields: { host: string; port: string; user: string; path: string }): (prompt: string) => string {
      return (prompt: string): string => {
        const p = prompt.toLowerCase();
        if (p.includes('key') || p.includes('private')) return '';
        if (p.includes('host')) return fields.host;
        if (p.includes('port')) return fields.port;
        if (p.includes('user')) return fields.user;
        if (p.includes('path')) return fields.path;
        return '';
      };
    }

    /**
     * choose() handler for tests whose server is unreachable, so the only menu
     * with >= 3 options is the offline host-key menu (the 3-option host-key
     * decision menu needs a reachable server); the 2-option menus (auth-method
     * selection, known_hosts key picker) fall through. `target` selects the
     * offline-menu option by a language-agnostic keyword; `keyPick` selects a
     * specific entry in the (2-option) known_hosts key picker. Matching by keyword
     * keeps the test independent of exact i18n wording.
     */
    function chooseOffline(target: 'paste' | 'known' | 'leave' | 'exit', keyPick?: RegExp): (message: string, options: string[]) => string {
      const patterns: Record<'paste' | 'known' | 'leave' | 'exit', RegExp> = {
        paste: /paste|wklej|enter.*fingerprint|odcisk/i,
        known: /known.?hosts/i,
        leave: /leave|without|no pin|unset|zostaw|bez/i,
        exit: /exit|cancel|abort|quit|wyjd|anuluj|przerwij/i,
      };
      return (_message: string, options: string[]): string => {
        if (options.length >= 3) {
          return options.find((o) => patterns[target].test(o)) ?? options[0] ?? '';
        }
        if (keyPick) {
          const picked = options.find((o) => keyPick.test(o));
          if (picked) return picked;
        }
        return options[0] ?? '';
      };
    }

    function editProvider(io: ProviderIO): SshProvider {
      return new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);
    }

    function existingConfig(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
      return { host: EXIST_HOST, port: 22, user: EDIT_USER, password: 'old-pw', path: '/backup', auth_method: 'password', host_key_fingerprint: OLD_PIN, ...overrides };
    }

    // -- Scenario 1: host + port unchanged, fingerprint already pinned ---------

    it('reuses the pinned fingerprint and does not contact the server when host and port are unchanged', async () => {
      // connectShouldFail proves NO server contact: a reuse path never dials, so
      // a dead server is irrelevant. The delegating stub dials and rejects -> RED.
      mockState.connectShouldFail = true;
      const { io } = scriptIo({ ask: fieldAsk({ host: EXIST_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'rotated-password', choose: (_m, o) => o[0] ?? '' });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig() };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: OLD_PIN });
    });

    it('does not re-confirm the host key nor show an offline menu when host and port are unchanged', async () => {
      mockState.connectShouldFail = true;
      const { io, calls } = scriptIo({ ask: fieldAsk({ host: EXIST_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'rotated-password', choose: (_m, o) => o[0] ?? '', confirm: () => false });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig() };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toBeDefined();
      // No TOFU confirm and no offline host-key menu - the pin is reused silently.
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3)).toBe(false);
    });

    // -- Scenario 2: identity changed, server unreachable -> offline menu -------

    it('falls back to the offline menu (no known_hosts option) and pins a pasted SHA256 fingerprint when the server is unreachable and the host changed', async () => {
      mockState.connectShouldFail = true; // server down -> offline menu
      let fpAsks = 0;
      const base = fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' });
      const ask = (prompt: string): string => {
        if (/fingerprint|sha256|odcisk|paste|wklej/i.test(prompt)) {
          fpAsks += 1;
          return PASTED_FP;
        }
        return base(prompt);
      };
      const { io, calls } = scriptIo({ ask, askSecret: () => 'pw', choose: chooseOffline('paste') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: PASTED_FP });
      expect(fpAsks).toBeGreaterThanOrEqual(1);
      const offlineMenu = calls.find((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3);
      expect(offlineMenu).toBeDefined();
      // No known_hosts key for NEW_HOST (default non-existent home) -> the menu
      // must NOT offer the known_hosts option.
      expect(offlineMenu?.options?.some((o) => /known.?hosts/i.test(o))).toBe(false);
    });

    it('warns and re-prompts when the pasted fingerprint has an invalid format', async () => {
      mockState.connectShouldFail = true;
      let fpAsks = 0;
      const base = fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' });
      const ask = (prompt: string): string => {
        if (/fingerprint|sha256|odcisk|paste|wklej/i.test(prompt)) {
          fpAsks += 1;
          return fpAsks === 1 ? 'not-a-valid-fingerprint' : PASTED_FP; // bad, then good
        }
        return base(prompt);
      };
      const { io, calls } = scriptIo({ ask, askSecret: () => 'pw', choose: chooseOffline('paste') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: PASTED_FP });
      // The bad format is rejected -> the fingerprint is asked again, and the exact
      // invalid-format warning surfaces.
      expect(fpAsks).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.kind === 'warn' && c.text === fmtFor('en', 'ssh_edit_fingerprint_invalid'))).toBe(true);
    });

    it('cancels via HostKeyDeclinedError when the pasted fingerprint is left empty', async () => {
      mockState.connectShouldFail = true;
      const base = fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' });
      // Empty input at the paste prompt (Enter pressed / stdin closed) must abandon
      // the paste and cancel - never spin the re-prompt loop forever.
      const ask = (prompt: string): string => (/fingerprint|sha256|odcisk|paste|wklej/i.test(prompt) ? '' : base(prompt));
      const { io } = scriptIo({ ask, askSecret: () => 'pw', choose: chooseOffline('paste') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
    });

    // The interactive init / provider add recovery loop lets an operator's refusal
    // of a server identity end the command by recognising IdentityDeclinedError;
    // a declined host key must stay one, or "no" would land in the retry menu.
    it('reports a declined host key as a refusal of the server identity', () => {
      expect(new HostKeyDeclinedError('declined')).toBeInstanceOf(IdentityDeclinedError);
    });

    it('surfaces the sole known_hosts key as a recommended proposal showing its fingerprint and pins it', async () => {
      const home = await makeTempHome();
      // Exactly one non-revoked key for NEW_HOST -> surfaced as a concrete, recommended proposal.
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `${NEW_HOST} ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;
      mockState.connectShouldFail = true;

      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: chooseOffline('known') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: SERVER_FP });
      const menu = calls.find((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3);
      const opts = menu?.options ?? [];
      // The proposal is first, shows the actual fingerprint (not a generic label), and is
      // the sole option flagged recommended (BFS will negotiate this type).
      expect(opts[0]).toContain(SERVER_FP);
      expect(opts[0]).toMatch(/recommend|zaleca/i);
      expect(opts.filter((o) => /recommend|zaleca/i.test(o))).toHaveLength(1);
    });

    it('lists multiple known_hosts keys as flat proposals ordered by ssh2 preference (ed25519 > ecdsa > rsa) with the top one recommended', async () => {
      const KEY_ED = Buffer.from('edit-known-key-ed25519');
      const KEY_ECDSA = Buffer.from('edit-known-key-ecdsa');
      const KEY_RSA = Buffer.from('edit-known-key-rsa');
      const FP_ED = sshFingerprint(KEY_ED);
      const FP_ECDSA = sshFingerprint(KEY_ECDSA);
      const FP_RSA = sshFingerprint(KEY_RSA);
      const home = await makeTempHome();
      // File order rsa, ed25519, ecdsa is deliberate: it defeats alphabetical sort,
      // file order, file-reversal, AND "ed25519-to-front, rest as-is". Only the true
      // ssh2 preference (ed25519 > ecdsa > rsa) satisfies the ordering asserted below.
      await fs.writeFile(
        path.join(home, '.ssh', 'known_hosts'),
        `${NEW_HOST} ssh-rsa ${KEY_RSA.toString('base64')}\n${NEW_HOST} ssh-ed25519 ${KEY_ED.toString('base64')}\n${NEW_HOST} ecdsa-sha2-nistp256 ${KEY_ECDSA.toString('base64')}\n`,
        'utf8',
      );
      mockState.homeDir = home;
      mockState.connectShouldFail = true;

      // A single flat menu - pick the ed25519 proposal directly (no separate key picker).
      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: (_m, o) => o.find((x) => x.includes(FP_ED)) ?? o[0] ?? '' });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      const config = await p.configureInteractiveForEdit(io, ctx);
      expect(config.host_key_fingerprint).toBe(FP_ED);

      // Flat: exactly one offline menu (>=3 opts), no separate key picker. (The
      // 2-option auth-method choose from field collection is excluded by >=3.)
      const menuChooses = calls.filter((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3);
      expect(menuChooses.length).toBe(1);
      const opts = menuChooses[0]?.options ?? [];
      const idxEd = opts.findIndex((o) => o.includes(FP_ED));
      const idxEcdsa = opts.findIndex((o) => o.includes(FP_ECDSA));
      const idxRsa = opts.findIndex((o) => o.includes(FP_RSA));
      // ssh2 negotiation preference, independent of the file order above.
      expect(idxEd).toBe(0);
      expect(idxEcdsa).toBeGreaterThan(idxEd);
      expect(idxRsa).toBeGreaterThan(idxEcdsa);
      // Exactly the top (ed25519) proposal carries the recommended marker.
      expect(opts[0]).toMatch(/recommend|zaleca/i);
      expect(opts.filter((o) => /recommend|zaleca/i.test(o))).toHaveLength(1);
    });

    it('leaves the pin empty and warns when the operator chooses to leave it unset', async () => {
      mockState.connectShouldFail = true;
      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: chooseOffline('leave') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: '' });
      expect(calls.some((c) => c.kind === 'warn' && c.text === fmtFor('en', 'ssh_edit_no_pin_warn'))).toBe(true);
    });

    it('throws HostKeyDeclinedError when the operator exits the offline menu', async () => {
      mockState.connectShouldFail = true;
      const { io } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: chooseOffline('exit') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
    });

    // -- Scenario 3: identity changed, server reachable, operator declines -----

    it('throws HostKeyDeclinedError when the host changed, the server is reachable, and the operator cancels at the key', async () => {
      // Reachable server, no known_hosts, no reusable pin (host changed): the
      // provider shows the fingerprint and the operator cancels -> abort. It must
      // NOT fall into the offline menu (the server IS reachable).
      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: chooseAuthAndTrust(0, ['cancel']) });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(1);
      expect(calls.some((c) => c.kind === 'choose' && isOfflineMenu(c.options ?? []))).toBe(false);
    });

    // Ctrl+C / Ctrl+D at the host-key menu belongs to the command, not to the
    // edit: the prompt layer's own error has to reach the caller unchanged. Only
    // a failure to READ the key means the server is unreachable - an interrupted
    // question about a key already read is not that, so it must not open the
    // offline menu as if the server had been down.
    //
    // The error is a class of its own that merely shares the prompt library's
    // name: in the published bundle the prompt library's error comes from a
    // second copy of that library, so `instanceof` against an imported class
    // would not recognise it there. A fix keyed on that import passes under tsx
    // and fails for the user; this test refuses it.
    it('lets a cancelled prompt at the host-key menu through instead of opening the offline menu', async () => {
      class ExitPromptError extends Error {}
      const interrupted = new ExitPromptError('User force closed the prompt with SIGINT');
      const { io, calls } = scriptIo({
        ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }),
        askSecret: () => 'pw',
        choose: (_m, o) => {
          if (isTrustMenu(o)) throw interrupted;
          return o[0] ?? '';
        },
      });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      const outcome = await p.configureInteractiveForEdit(io, ctx).then(
        () => null,
        (err: unknown) => err,
      );

      expect(calls.some((c) => c.kind === 'choose' && isOfflineMenu(c.options ?? []))).toBe(false);
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(1);
      expect(outcome).toBe(interrupted);
    });

    // -- Going back to the prompts -------------------------------------------
    // Refusing a server identity during an edit usually means "I typed the wrong
    // address". Both identity decisions - the live host-key menu and the offline
    // menu - lead back to the prompts, and the second pass is judged afresh.

    it('collects the fields again after "back" at the host-key menu, and the second pass reuses the pin', async () => {
      // First pass aims at NEW_HOST (reachable, unknown key); the second pass types
      // the stored address again, so the pin is reused without contact.
      let pass = 0;
      const ask = (prompt: string): string => {
        const p = prompt.toLowerCase();
        if (p.includes('host') && !p.includes('key')) pass += 1;
        return fieldAsk({ host: pass === 1 ? NEW_HOST : EXIST_HOST, port: '22', user: EDIT_USER, path: '/backup' })(prompt);
      };
      const { io, calls } = scriptIo({ ask, askSecret: () => 'pw', choose: chooseAuthAndTrust(0, ['back']) });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig() };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host: EXIST_HOST, host_key_fingerprint: OLD_PIN });
      expect(hostPrompts(calls)).toBe(2);
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(1);
      expect(calls.some((c) => c.kind === 'choose' && isOfflineMenu(c.options ?? []))).toBe(false);
    });

    // The mirror direction in an edit: back from a live server A, then a live
    // server B that is not the stored address. B must be pinned with ITS OWN key.
    it('pins the key of the second live server after "back" from the first one', async () => {
      const otherKey = Buffer.from('mock-ssh-ed25519-host-key-of-edit-server-b');
      let pass = 0;
      const ask = (prompt: string): string => {
        const p = prompt.toLowerCase();
        if (p.includes('host') && !p.includes('key')) pass += 1;
        return fieldAsk({ host: pass === 1 ? NEW_HOST : 'third-host', port: '22', user: EDIT_USER, path: '/backup' })(prompt);
      };
      const { io, calls } = scriptIo({
        ask,
        askSecret: () => 'pw',
        choose: chooseAuthAndTrust(0, ['back', 'accept'], (n) => {
          if (n === 0) mockState.hostKey = otherKey;
        }),
      });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig() };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host: 'third-host', host_key_fingerprint: sshFingerprint(otherKey) });
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(2);
    });

    it('offers "back" in the offline menu, after the paste option, and collects the fields again', async () => {
      mockState.connectShouldFail = true;
      let pass = 0;
      const ask = (prompt: string): string => {
        const p = prompt.toLowerCase();
        if (p.includes('host') && !p.includes('key')) pass += 1;
        return fieldAsk({ host: pass === 1 ? NEW_HOST : EXIST_HOST, port: '22', user: EDIT_USER, path: '/backup' })(prompt);
      };
      const { io, calls } = scriptIo({ ask, askSecret: () => 'pw', choose: (_m, o) => (isOfflineMenu(o) ? (o.find((x) => x === fmtFor('en', 'trust_choice_back')) ?? '') : (o[0] ?? '')) });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig() };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host: EXIST_HOST, host_key_fingerprint: OLD_PIN });
      const offline = calls.filter((c) => c.kind === 'choose' && isOfflineMenu(c.options ?? []));
      expect(offline).toHaveLength(1);
      // No known_hosts entry for NEW_HOST, so the menu is exactly these four, in
      // this order: pasting stays first (operators answer it by position).
      expect(offline[0]?.options).toEqual([fmtFor('en', 'ssh_edit_offline_paste'), fmtFor('en', 'trust_choice_back'), fmtFor('en', 'ssh_edit_offline_no_pin'), fmtFor('en', 'ssh_edit_offline_exit')]);
      expect(hostPrompts(calls)).toBe(2);
    });

    it('shares one restart budget between the host-key menu and the offline menu', async () => {
      // Passes alternate between a reachable new server (host-key menu) and an
      // unreachable one (offline menu); every answer is "back". The budget is per
      // configure call, not per menu, so the fourth return ends the edit.
      const { io, calls } = scriptIo({
        ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }),
        askSecret: () => 'pw',
        choose: (_m, o) => {
          if (isTrustMenu(o) || isOfflineMenu(o)) {
            // The next pass reaches the other menu.
            mockState.connectShouldFail = !mockState.connectShouldFail;
            return fmtFor('en', 'trust_choice_back');
          }
          return o[0] ?? '';
        },
      });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(fmtFor('en', 'configure_restarts_exhausted_edit'));
      expect(calls.filter((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toHaveLength(2);
      expect(calls.filter((c) => c.kind === 'choose' && isOfflineMenu(c.options ?? []))).toHaveLength(2);
    });

    // -- Scenario 4: identity changed, server reachable, key @revoked ----------

    it('warns ssh_host_key_revoked and throws HostKeyDeclinedError when the server key is @revoked during an online edit', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked ${NEW_HOST} ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home; // reachable server (connectShouldFail stays false)

      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', confirm: () => true });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
      // The revoke reason is surfaced (fail-closed), not a generic error.
      expect(calls.some((c) => c.kind === 'warn' && c.text === fmtFor('en', 'ssh_host_key_revoked', `${EDIT_USER}@${NEW_HOST}:22`))).toBe(true);
      // A revoked key is refused outright: no menu, so no way to trust it anyway.
      expect(calls.some((c) => c.kind === 'choose' && isTrustMenu(c.options ?? []))).toBe(false);
    });

    // -- Scenario 5: identity changed, reachable, accept -------------------------
    // The online accept path pins the LIVE server fingerprint.
    it('pins the live server fingerprint when the host changed, the server is reachable, and the operator accepts', async () => {
      const { io } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', choose: chooseAuthAndTrust(0, ['accept']) });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: SERVER_FP });
    });
  });
});

// --- Header sidecar (BFSH) -------------------------------------------------
// SSH is a built-in provider, so it keeps a relocated shard's updated header in
// an `hdr_i.bfs.V` sidecar next to the shard (payload write-once). The `hdr_`
// prefix keeps it out of every `list('shard_')` scan structurally.
describe('SshProvider - header sidecar (BFSH)', () => {
  let provider: SshProvider;
  const shardRef = { provider_id: 'test-ssh', path: 'shard_0.bfs.1' };
  const SIDECAR_KEY = '/backup/testvault/hdr_0.bfs.1';

  beforeEach(() => {
    resetMockState();
    const { io } = createMockProviderIO();
    provider = new SshProvider(makeConfig(), io);
    provider.setVaultName('testvault');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should report usesSidecar() === true', () => {
    expect(provider.usesSidecar()).toBe(true);
  });

  it('should round-trip header bytes through uploadHeaderSidecar/downloadHeaderSidecar', async () => {
    const sidecar = Buffer.from('BFSH-header-bytes');

    await provider.uploadHeaderSidecar(shardRef, sidecar);
    const read = await provider.downloadHeaderSidecar(shardRef, 16384);

    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, sidecar)).toBe(0);
  });

  it('should return null from downloadHeaderSidecar when no sidecar exists', async () => {
    await expect(provider.downloadHeaderSidecar(shardRef, 16384)).resolves.toBeNull();
  });

  it('should remove a stale sidecar when the shard is re-uploaded (reconcile)', async () => {
    mockState.files.set(SIDECAR_KEY, Buffer.from('stale-sidecar'));

    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));

    expect(mockState.files.has(SIDECAR_KEY)).toBe(false);
  });

  it('should remove the sidecar when the shard is deleted', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    mockState.files.set(SIDECAR_KEY, Buffer.from('sidecar'));

    await provider.delete(shardRef);

    expect(mockState.files.has(SIDECAR_KEY)).toBe(false);
  });
});
