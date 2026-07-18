import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostKeyDeclinedError, ProviderError, UnsafePathError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import { buildShard, parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmtFor } from '../../src/i18n/index.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { SshProvider } from '../../src/providers/ssh.js';
import type { CliProviderInput, ConfigureEditContext, ProviderConfig, ProviderIO, RecoverySecret, RemoteRef, ShardHeader, ShardLocation } from '../../src/types/index.js';

// ─── Fixed host key + fingerprint contract ───────────────────────────────────
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

// ─── In-memory SSH / SFTP mock ───────────────────────────────────────────────

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
  /** Fake SFTP filesystem: full remote path → bytes. */
  files: Map<string, Buffer>;
  /** Fake SFTP directories: full remote path. */
  dirs: Set<string>;
  /** Connect emits a code-less, level-less transport error (→ unverifiable). */
  connectShouldFail: boolean;
  /** Connect emits an error carrying `level: 'client-authentication'` (→ auth_failed). */
  authShouldFail: boolean;
  /** Raw host-key bytes handed to the client's hostVerifier during handshake. */
  hostKey: Buffer;
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
   * When true, the write stream emits 'close' but suppresses 'finish' — modeling
   * ssh2's SFTP WriteStream, which closes the remote handle ('close') and never
   * fires 'finish'. Guards against regressing upload to await 'finish' alone.
   */
  suppressWriteFinish: boolean;
  /**
   * When true, SFTP operations after `ready` never respond — readdir/stat
   * callbacks never fire and read streams emit nothing. Models a hung-but-alive
   * server that completes the handshake, then goes silent (the M1 DoS: no
   * per-operation timeout means push/pull/verify hangs forever).
   */
  sftpHang: boolean;
  /**
   * When set, a read stream emits `streamChunks` chunks, one every
   * `streamChunkDelayMs` ms — drives fake-timer tests that the idle timeout
   * RESETS on each received payload (a slow-but-progressing transfer completes).
   */
  streamChunkDelayMs: Nullable<number>;
  streamChunks: number;
} = {
  files: new Map<string, Buffer>(),
  dirs: new Set<string>(),
  connectShouldFail: false,
  authShouldFail: false,
  hostKey: SERVER_KEY,
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
    // 'close' alone. The internal finished→autoDestroy→'close' transition is
    // unaffected (it does not depend on this emit's return value).
    if (mockState.suppressWriteFinish && event === 'finish') return false;
    return super.emit(event, ...args);
  }
}

const mockSftp = {
  readdir(dir: string, cb: (err: Error | null, list?: MockDirEntry[]) => void): void {
    if (mockState.sftpHang) return; // never respond — models a stalled server after ready
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

  stat(p: string, cb: (err: Error | null, stats?: MockAttrs) => void): void {
    if (mockState.sftpHang) return; // never respond — stalled server after ready
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
    // 'data'/'end'/'error') — the transfer hangs forever without a timeout.
    if (mockState.sftpHang) return new Readable({ read() {} });
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

  rename(from: string, to: string, cb: (err: Error | null) => void): void {
    const data = mockState.files.get(from);
    if (!data) {
      cb(sftpError(`No such file: ${from}`, 2));
      return;
    }
    mockState.files.set(to, data);
    mockState.files.delete(from);
    cb(null);
  },

  unlink(p: string, cb: (err: Error | null) => void): void {
    if (!mockState.files.has(p)) {
      cb(sftpError(`No such file: ${p}`, 2));
      return;
    }
    mockState.files.delete(p);
    cb(null);
  },

  mkdir(p: string, cb: (err: Error | null) => void): void {
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
            if (!ok) {
              this.emit('error', Object.assign(new Error('Host key verification failed'), { level: 'client-authentication' }));
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

    sftp(cb: (err: Error | null, sftp?: typeof mockSftp) => void): void {
      cb(null, mockSftp);
    }

    end(): void {
      // no-op
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function writeJsonConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ssh-cfg-'));
  const file = path.join(dir, 'ssh.json');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function cliInput(overrides: Partial<CliProviderInput> = {}): CliProviderInput {
  return { name: overrides.name ?? 'test', rawArgs: overrides.rawArgs ?? [] };
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
}

// ─── Tests ───────────────────────────────────────────────────────────────────

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

  // ─── constructor (lazy init — validation via validateConfig) ─────────────

  it('should NOT throw when host is missing — config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider(makeConfig({ host: '' }), io)).not.toThrow();
  });

  it('should NOT throw when path is missing — config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider(makeConfig({ path: '' }), io)).not.toThrow();
  });

  it('should accept an empty config object for placeholder use in configure flows', () => {
    const { io } = createMockProviderIO();
    expect(() => new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io)).not.toThrow();
  });

  // ─── diagnostic logging (gated by `bfs --debug`) ─────────────────────────

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

  // ─── control-character / traversal rejection in vault name ───────────────

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

  // ─── upload / download roundtrip ─────────────────────────────────────────

  it('should upload and download identical binary data', async () => {
    const data = Buffer.alloc(512);
    for (let i = 0; i < 512; i++) data[i] = i % 256;

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);

    expect(downloaded).toEqual(data);
  });

  it('should return correct provider_id, path, and 64-char hash after upload', async () => {
    const data = Buffer.from('test-data');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(ref.provider_id).toBe('test-ssh');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64);
  });

  // ─── post-upload verification (defense against silent SFTP corruption) ────

  it('should throw ProviderError when the server stored fewer bytes than uploaded', async () => {
    // The post-upload `stat` reports the truncated size, so the size check fails.
    mockState.corruptOnUpload = (buf) => buf.subarray(0, buf.length - 1);
    const data = Buffer.alloc(256, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).rejects.toThrow(ProviderError);
  });

  // ─── chunking regression (CRITICAL — streaming.md) ───────────────────────

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
    // alone hangs forever against a real server — invisible to a mock that emits
    // both. With 'finish' suppressed, upload() must still resolve (via 'close').
    mockState.suppressWriteFinish = true;
    const data = Buffer.alloc(4 * 1024, 0xcd);

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(ref.path).toBe('shard_0.bfs.1');
    expect(mockState.files.get('/backup/testvault/shard_0.bfs.1')?.length).toBe(data.length);
  });

  // ─── list ────────────────────────────────────────────────────────────────

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

  // ─── delete ──────────────────────────────────────────────────────────────

  it('should delete a file', async () => {
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('data'));
    await provider.delete(ref);

    const refs = await provider.list();
    expect(refs.map((r: RemoteRef) => r.path)).not.toContain('shard_0.bfs.1');
  });

  // Deleting an already-absent shard is idempotent (success), not an error — see
  // the "hardening" block (L6). It must not raise a false prune orphan warning.

  // ─── healthCheck ─────────────────────────────────────────────────────────

  it('should return true when connection succeeds', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false when connection fails', async () => {
    mockState.connectShouldFail = true;
    expect(await provider.healthCheck()).toBe(false);
  });

  // ─── authenticate ────────────────────────────────────────────────────────

  it('should not throw when connection succeeds', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should throw ProviderError when connection fails', async () => {
    mockState.connectShouldFail = true;
    await expect(provider.authenticate()).rejects.toThrow(ProviderError);
  });

  // ─── rename ──────────────────────────────────────────────────────────────

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

  // ─── updateShardHeader ───────────────────────────────────────────────────

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

  // ─── listVaults ──────────────────────────────────────────────────────────

  it('should list vault directories from basePath', async () => {
    mockState.dirs.add('/backup/vault-a');
    mockState.dirs.add('/backup/vault-b');

    const { io } = createMockProviderIO();
    const p = new SshProvider(makeConfig(), io);
    const vaults = await p.listVaults();

    expect(vaults.sort()).toEqual(['vault-a', 'vault-b']);
  });

  // ─── getSize ──────────────────────────────────────────────────────────────

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

  // ─── downloadHeader ───────────────────────────────────────────────────────

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

  // ─── configureInteractive (dual-auth) ─────────────────────────────────────

  describe('configureInteractive', () => {
    it('should prompt for all fields and return a password-method config', async () => {
      // choose returns the first option = password auth (option order [password, key]).
      // confirm → true accepts the TOFU host-key prompt so a fingerprint is pinned.
      const { io } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: (_m, o) => o[0] ?? '', confirm: () => true });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toMatchObject({ host: 'ssh.example.com', port: 2222, user: 'alice', path: '/backup', auth_method: 'password', password: 'supersecret', host_key_fingerprint: SERVER_FP });
      expect(config.private_key_path).toBeUndefined();
    });

    it('should collect a private key by PATH only (never prompt to paste the key body)', async () => {
      // choose returns the second option = key auth. No passphrase (askSecret → '').
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => '', choose: (_m, o) => o[1] ?? '', confirm: () => true });
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
      const { io } = scriptIo({ ask: interactiveAsk, askSecret: (p) => (/phrase/i.test(p) ? 'keypass' : ''), choose: (_m, o) => o[1] ?? '', confirm: () => true });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toMatchObject({ auth_method: 'key', private_key_path: '/home/alice/.ssh/id_ed25519', passphrase: 'keypass', host_key_fingerprint: SERVER_FP });
    });

    it('should default the port to 22 when the user leaves it empty', async () => {
      const ask = (prompt: string): string => (/port/i.test(prompt) ? '' : interactiveAsk(prompt));
      const { io } = scriptIo({ ask, askSecret: () => 'secret', choose: (_m, o) => o[0] ?? '', confirm: () => true });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.port).toBe(22);
      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    // configureInteractive owns TOFU: after collecting parameters it connects,
    // reads the host key, consults ~/.ssh/known_hosts (entry → trust silently),
    // else prompts io.confirm and pins host_key_fingerprint on acceptance —
    // because `bfs init` persists ONLY configureInteractive's result, not the
    // probeConnection connect. The TOFU host-key scan captures the key during the
    // handshake and does not require the private key file to be readable.
    it('should pin the fingerprint after the operator accepts the TOFU prompt', async () => {
      const { io, calls } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: (_m, o) => o[0] ?? '', confirm: () => true });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      const confirmCall = calls.find((c) => c.kind === 'confirm');
      expect(confirmCall).toBeDefined();
      expect(confirmCall?.text).toContain(SERVER_FP);
      expect(config.host_key_fingerprint).toBe(SERVER_FP);
    });

    it('should throw ProviderError when the operator declines the TOFU prompt', async () => {
      const { io } = scriptIo({ ask: interactiveAsk, askSecret: () => 'supersecret', choose: (_m, o) => o[0] ?? '', confirm: () => false });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      await expect(p.configureInteractive(io)).rejects.toThrow(ProviderError);
    });

    it('should pin silently (no prompt) when the host is already in ~/.ssh/known_hosts', async () => {
      const home = await makeTempHome();
      // Interactive host is ssh.example.com on the default port 22, so the
      // known_hosts key is the bare hostname (no [host]:port bracket form).
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `ssh.example.com ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const ask = (prompt: string): string => (/port/i.test(prompt) ? '' : interactiveAsk(prompt));
      const { io, calls } = scriptIo({ ask, askSecret: () => 'supersecret', choose: (_m, o) => o[0] ?? '', confirm: () => false });
      const { io: ctorIO } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.host_key_fingerprint).toBe(SERVER_FP);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });
  });

  // ─── configureFromFlags ───────────────────────────────────────────────────

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
  });

  // ─── validateConfig ───────────────────────────────────────────────────────

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

  // ─── describeConfig ───────────────────────────────────────────────────────

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

    it('should mask the password field — no plaintext, asterisks present', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ssh.example.com', port: 22, user: 'alice', password: 'supersecret', path: '/backup', auth_method: 'password' });

      expect(desc).not.toContain('supersecret');
      expect(desc).toMatch(/\*{3,}/);
    });

    it('should mask the passphrase field — no plaintext, asterisks present', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ssh.example.com', port: 22, user: 'alice', private_key_path: '/keys/id_ed25519', passphrase: 'topsecret', path: '/backup', auth_method: 'key' });

      expect(desc).not.toContain('topsecret');
      expect(desc).toMatch(/\*{3,}/);
      expect(desc).toContain('/keys/id_ed25519');
    });
  });

  // ─── getSecretFields ──────────────────────────────────────────────────────

  describe('getSecretFields', () => {
    it('should return ["password", "passphrase"]', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);
      expect(p.getSecretFields()).toEqual(['password', 'passphrase']);
    });
  });

  // ─── probeConnection ──────────────────────────────────────────────────────

  describe('probeConnection', () => {
    it('should upload, download, compare, and clean up — leaving no residue', async () => {
      await provider.probeConnection();

      const refs = await provider.list();
      expect(refs).toEqual([]);
    });

    it('should throw ProviderError when the SSH connection fails', async () => {
      mockState.connectShouldFail = true;
      await expect(provider.probeConnection()).rejects.toThrow(ProviderError);
    });
  });

  // ─── verifyShard ──────────────────────────────────────────────────────────

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

  // ─── host-key verification (TOFU + known_hosts, CI gate) ───────────────────
  //
  // GUESSED API surfaced in the report:
  //  - The provider builds `cfg.hostVerifier(key, cb)`; cb(true) trusts, cb(false)
  //    rejects. A rejection makes connect emit an error → ProviderError.
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

    it('should refuse when the pinned fingerprint does not match the server key', async () => {
      const { io } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: 'SHA256:deadbeefdeadbeefdeadbeefdeadbeef' }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
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
    // line. Only an @revoked entry overrides a pin — see the hardening block.
    it('should let a config pin override known_hosts (pin authoritative)', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      const { io } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: 'SHA256:deadbeefdeadbeefdeadbeefdeadbeef' }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
    });

    it('should refuse a new host in non-interactive mode without --accept-new-host-key', async () => {
      const { io, calls } = scriptIo({ confirm: () => true, interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });

    it('should accept a new host in non-interactive mode when accept_new_host_key is set', async () => {
      const { io, calls } = scriptIo({ interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: null, accept_new_host_key: true }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
    });

    it('should accept in non-interactive mode when the fingerprint was pinned via --known-host', async () => {
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).resolves.toBeUndefined();
    });
  });

  // ─── H1: --accept-new-host-key must PIN (real TOFU), not trust every time ──
  //
  // Regression guard for a MITM window: `--accept-new-host-key` on a
  // non-interactive `provider add`/`init` (no `--known-host`) must capture the
  // host key on first contact and PIN its fingerprint into the config — the
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

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
    });

    // Guard: once a pin exists, --accept-new-host-key is a no-op — it must NOT
    // recapture and overwrite the authoritative pin with whatever key the server
    // now presents. (The counterpart — a mismatched key being refused against an
    // existing pin — is already covered by "should refuse when the pinned
    // fingerprint does not match the server key" in the host-key verification
    // block; not duplicated here.)
    it('should NOT overwrite an existing --known-host pin when --accept-new-host-key is also given', async () => {
      const EXISTING_PIN = 'SHA256:existingpinexistingpinexistingpinexistingpin';
      const { io } = scriptIo({ interactive: false });
      const p = new SshProvider({ id: 'p2', type: 'ssh', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'sshhost', '--user', 'sshuser', '--password', 'p', '--path', '/backup', '--known-host', EXISTING_PIN, '--accept-new-host-key'] }));

      expect(config.host_key_fingerprint).toBe(EXISTING_PIN);
    });
  });

  // ─── M1: per-operation SFTP idle timeout (DoS) ───────────────────────────
  //
  // A malicious or hung-but-alive SSH server completes the handshake (so `ready`
  // fires, passing readyTimeout) then never answers an SFTP request. Without a
  // per-operation idle timeout the operation — and the whole CLI command — hangs
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
    // under test would never be armed. Resolve the (absent — homeDir points at a
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

    // The idle timeout must RESET on each received payload — a slow-but-
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

  // ─── hardening (L1 revoked host key, L2 path traversal, L4 auth conflict, L6 idempotent delete) ───
  describe('hardening', () => {
    // L1 — an @revoked entry in ~/.ssh/known_hosts marks the key compromised; it
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
    // any source wins over trust (fail-closed) — the pin alone must not authorize
    // a connection the operator marked @revoked. The refusal surfaces the reason
    // (revoked) so the operator understands why, not a generic transport failure.
    it('should hard-refuse a @revoked host key even when the fingerprint is pinned', async () => {
      const home = await makeTempHome();
      await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), `@revoked sshhost ssh-ed25519 ${SERVER_KEY.toString('base64')}\n`, 'utf8');
      mockState.homeDir = home;

      // Pin equals the presented key's fingerprint. Revocation is checked before
      // the pin, so a pinned-but-revoked key is refused (fail-closed) — the pin
      // alone does not authorize a connection the operator marked @revoked.
      const { io, calls } = scriptIo({ confirm: () => true });
      const p = new SshProvider(makeConfig({ host_key_fingerprint: SERVER_FP }), io);
      p.setVaultName('testvault');

      await expect(p.authenticate()).rejects.toThrow(ProviderError);
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false); // hard refuse, no prompt
      expect(calls.some((c) => c.kind === 'warn' && /revoked/i.test(c.text))).toBe(true); // reason surfaced
    });

    // L2 — a ref.path with a traversal segment must be rejected before it is
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

    // L4 — validateConfig must reject a config carrying BOTH a password and a key,
    // matching configureFromFlags (which throws ssh_auth_conflict). A hand-edited
    // config with both must not silently validate.
    it('should reject a config that carries both a password and a private key', () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider({ id: 'stub', type: 'ssh', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'h', port: 22, path: '/b', auth_method: 'password', password: 'p', private_key_path: '/k' });

      expect(errors.length).toBeGreaterThan(0);
    });

    // L6 — delete must be idempotent: an already-absent shard is success, not a
    // throw. Otherwise prune emits a false "possible orphan" warning for data that
    // is already gone.
    it('should treat deleting an already-absent shard as success (idempotent)', async () => {
      const { io } = createMockProviderIO();
      const p = new SshProvider(makeConfig(), io);
      p.setVaultName('testvault');

      // shard_9.bfs.1 was never uploaded → absent from the mock filesystem.
      await expect(p.delete({ provider_id: 'test-ssh', path: 'shard_9.bfs.1' })).resolves.toBeUndefined();
    });

    // F1 — delete removes the header sidecar together with the shard, so prune
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

  // ─── auth-defaults (~/.ssh key discovery) ─────────────────────────────────

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

  // ─── connectForRecovery (anti-phishing: show host BEFORE the secret) ───────

  describe('connectForRecovery', () => {
    type WithRecovery = SshProvider & { connectForRecovery(io: ProviderIO, pool: readonly RecoverySecret[], options?: { trustLocation?: boolean }): Promise<string | null> };

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

    // Transport failure ≠ rejected secret. A "connection lost before the
    // handshake" is a code-less/level-less transport error (wrapped as a
    // ProviderError), not an authentication rejection. In a NON-interactive
    // recovery (io.interactive === false) there is no operator to answer, so
    // connectForRecovery must never fall through to io.askSecret — it must
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
      // Connect cannot be established at all → code-less, level-less error →
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

    // Transport failure ≠ rejected secret, in INTERACTIVE mode too. A pooled
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
    // is the counterpart to the transport case above — together they prove the
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
  });

  // ─── configureInteractiveForEdit (offline-first host-key handling) ─────────
  //
  // `bfs provider edit <ssh>` must keep the offline-edit contract while still
  // handling host-key trust intelligently:
  //   (1) host AND port unchanged with a fingerprint already pinned → reuse the
  //       pin WITHOUT contacting the server;
  //   (2) identity changed (host/port) or no old pin AND the server unreachable →
  //       drop into an OFFLINE MENU (io.choose: paste / use known_hosts / leave
  //       unset / exit) instead of failing;
  //   (3) identity changed AND the server reachable but the operator refuses the
  //       shown key (or the key is @revoked) → abort with HostKeyDeclinedError.
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
     * choose() handler. The offline host-key menu carries >= 3 options
     * (paste / [known_hosts] / leave / exit); the 2-option menus (auth-method
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

    // ── Scenario 1: host + port unchanged, fingerprint already pinned ─────────

    it('reuses the pinned fingerprint and does not contact the server when host and port are unchanged', async () => {
      // connectShouldFail proves NO server contact: a reuse path never dials, so
      // a dead server is irrelevant. The delegating stub dials and rejects → RED.
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
      // No TOFU confirm and no offline host-key menu — the pin is reused silently.
      expect(calls.some((c) => c.kind === 'confirm')).toBe(false);
      expect(calls.some((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3)).toBe(false);
    });

    // ── Scenario 2: identity changed, server unreachable → offline menu ───────

    it('falls back to the offline menu (no known_hosts option) and pins a pasted SHA256 fingerprint when the server is unreachable and the host changed', async () => {
      mockState.connectShouldFail = true; // server down → offline menu
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
      // No known_hosts key for NEW_HOST (default non-existent home) → the menu
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
      // The bad format is rejected → the fingerprint is asked again, and the exact
      // invalid-format warning surfaces.
      expect(fpAsks).toBeGreaterThanOrEqual(2);
      expect(calls.some((c) => c.kind === 'warn' && c.text === fmtFor('en', 'ssh_edit_fingerprint_invalid'))).toBe(true);
    });

    it('cancels via HostKeyDeclinedError when the pasted fingerprint is left empty', async () => {
      mockState.connectShouldFail = true;
      const base = fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' });
      // Empty input at the paste prompt (Enter pressed / stdin closed) must abandon
      // the paste and cancel — never spin the re-prompt loop forever.
      const ask = (prompt: string): string => (/fingerprint|sha256|odcisk|paste|wklej/i.test(prompt) ? '' : base(prompt));
      const { io } = scriptIo({ ask, askSecret: () => 'pw', choose: chooseOffline('paste') });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
    });

    it('surfaces the sole known_hosts key as a recommended proposal showing its fingerprint and pins it', async () => {
      const home = await makeTempHome();
      // Exactly one non-revoked key for NEW_HOST → surfaced as a concrete, recommended proposal.
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

      // A single flat menu — pick the ed25519 proposal directly (no separate key picker).
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

    // ── Scenario 3: identity changed, server reachable, operator declines ─────

    it('throws HostKeyDeclinedError when the host changed, the server is reachable, and the operator declines the key', async () => {
      // Reachable server, no known_hosts, no reusable pin (host changed): the
      // provider shows the fingerprint and the operator refuses → abort. It must
      // NOT fall into the offline menu (the server IS reachable).
      const { io, calls } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', confirm: () => false });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).rejects.toThrow(HostKeyDeclinedError);
      expect(calls.some((c) => c.kind === 'choose' && (c.options?.length ?? 0) >= 3)).toBe(false);
    });

    // ── Scenario 4: identity changed, server reachable, key @revoked ──────────

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
    });

    // ── Scenario 5 (GUARD, already green): identity changed, reachable, accept ─
    // Not RED — documents that the online accept path pins the LIVE server
    // fingerprint, so the offline-first refactor must preserve it.
    it('pins the live server fingerprint when the host changed, the server is reachable, and the operator accepts', async () => {
      const { io } = scriptIo({ ask: fieldAsk({ host: NEW_HOST, port: '22', user: EDIT_USER, path: '/backup' }), askSecret: () => 'pw', confirm: () => true });
      const p = editProvider(io);
      const ctx: ConfigureEditContext = { existingConfig: existingConfig({ host: EXIST_HOST }) };

      await expect(p.configureInteractiveForEdit(io, ctx)).resolves.toMatchObject({ host_key_fingerprint: SERVER_FP });
    });
  });
});

// ─── Header sidecar (BFSH) ─────────────────────────────────────────────────
// SSH is a built-in provider, so it keeps a relocated shard's updated header in
// an `hdr_i.bfs.V` sidecar next to the shard (payload write-once). The `hdr_`
// prefix keeps it out of every `list('shard_')` scan structurally.
describe('SshProvider — header sidecar (BFSH)', () => {
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
