import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, UnsafePathError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import { buildShard, parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { CliProviderInput, ProviderConfig, ProviderIO, ShardHeader, ShardLocation } from '../../src/types/index.js';

async function writeJsonConfig(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ftp-cfg-'));
  const file = path.join(dir, 'ftp.json');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

function cliInput(overrides: Partial<CliProviderInput> = {}): CliProviderInput {
  return { name: overrides.name ?? 'test', rawArgs: overrides.rawArgs ?? [] };
}

// ─── In-memory FTP mock ──────────────────────────────────────────────────────

const mockState: {
  files: Map<string, Buffer>;
  dirs: Set<string>;
  accessShouldFail: boolean;
  /** When set, access() throws an error carrying this numeric FTP reply code (e.g. 530). */
  accessErrorCode: Nullable<number>;
  sentCommands: string[];
  /**
   * Optional post-STOR corruption hook. Receives the buffer that arrived from
   * the client; returns the buffer that should actually be persisted under
   * remotePath. Used to simulate ASCII-mode / truncation / byte-flip bugs
   * that real FTP servers can introduce silently.
   */
  corruptOnUpload: Nullable<(buf: Buffer) => Buffer>;
  /**
   * Per-attempt byte loss plan. `uploadByteLossPlan[i]` bytes are dropped from
   * the end of the buffer received during the i-th STOR call. Models sporadic
   * vsftpd/Docker truncation that disappears on retry.
   */
  uploadByteLossPlan: number[];
  /** Number of STOR calls observed since the last reset. */
  uploadAttempt: number;
  /**
   * Optional override for the value returned by `client.size()`. Receives the
   * actual stored buffer length; returns whatever the mock should report.
   * Used to simulate the metadata-propagation race on writeback-cached
   * filesystems where `stat()` briefly returns a stale size.
   */
  sizeOverride: Nullable<(actualSize: number) => number>;
  /**
   * Sizes of chunks emitted by the most recent upload's source stream.
   * Used to verify uploads use chunked streams (cooperative backpressure)
   * rather than pushing the whole buffer as a single multi-MB chunk.
   */
  lastUploadChunkSizes: number[];
  /**
   * If set, downloadTo emits the file in fixed-size chunks instead of a
   * single write(). Lets tests verify that downloadHeader stops the
   * transfer early after destroying the writable.
   */
  downloadChunkSize: Nullable<number>;
  /**
   * Number of bytes the most recent download forwarded into the writable
   * before the writable was destroyed (early abort) or end-of-file.
   * Used to verify downloadHeader doesn't pull the whole shard.
   */
  lastDownloadBytesWritten: number;
} = {
  files: new Map<string, Buffer>(),
  dirs: new Set<string>(),
  accessShouldFail: false,
  accessErrorCode: null,
  sentCommands: [],
  corruptOnUpload: null,
  uploadByteLossPlan: [],
  uploadAttempt: 0,
  sizeOverride: null,
  lastUploadChunkSizes: [],
  downloadChunkSize: null,
  lastDownloadBytesWritten: 0,
};

vi.mock('basic-ftp', () => {
  class MockFtpContext {
    readonly timeout = 0;
  }

  class MockClient {
    ftp = new MockFtpContext();

    async access(): Promise<void> {
      if (mockState.accessShouldFail) {
        throw new Error('ECONNREFUSED');
      }
      if (mockState.accessErrorCode !== null) {
        throw Object.assign(new Error(`${mockState.accessErrorCode} access rejected`), { code: mockState.accessErrorCode });
      }
    }

    async send(cmd: string): Promise<{ code: number; message: string }> {
      mockState.sentCommands.push(cmd);
      return { code: 200, message: 'OK' };
    }

    async uploadFrom(readable: Readable, remotePath: string): Promise<void> {
      const chunks: Buffer[] = [];
      mockState.lastUploadChunkSizes = [];
      for await (const chunk of readable) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(buf);
        mockState.lastUploadChunkSizes.push(buf.length);
      }
      const received = Buffer.concat(chunks);
      const attemptIndex = mockState.uploadAttempt;
      mockState.uploadAttempt += 1;
      const loss = mockState.uploadByteLossPlan[attemptIndex] ?? 0;
      let stored: Buffer = loss > 0 ? Buffer.from(received.subarray(0, received.length - loss)) : received;
      if (mockState.corruptOnUpload) stored = mockState.corruptOnUpload(stored);
      mockState.files.set(remotePath, stored);
    }

    async downloadTo(writable: NodeJS.WritableStream, remotePath: string): Promise<void> {
      const data = mockState.files.get(remotePath);
      if (!data) throw new Error(`File not found: ${remotePath}`);
      mockState.lastDownloadBytesWritten = 0;
      const chunkSize = mockState.downloadChunkSize;
      if (chunkSize === null) {
        writable.write(data);
        mockState.lastDownloadBytesWritten = data.length;
        writable.end();
        return;
      }
      // Emit the file in fixed chunks, watching for writable.destroy() so the
      // mock mirrors basic-ftp's behavior: a destroyed sink aborts the
      // transfer with an error instead of silently completing.
      const isDestroyed = (s: NodeJS.WritableStream): boolean => (s as { destroyed?: boolean }).destroyed === true || (s as { writableFinished?: boolean }).writableFinished === true;
      let offset = 0;
      while (offset < data.length) {
        if (isDestroyed(writable)) {
          throw new Error('Writable destroyed mid-transfer');
        }
        const end = Math.min(offset + chunkSize, data.length);
        const chunk = data.subarray(offset, end);
        const ok = writable.write(chunk);
        mockState.lastDownloadBytesWritten += chunk.length;
        if (isDestroyed(writable)) {
          throw new Error('Writable destroyed mid-transfer');
        }
        if (!ok) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
              writable.removeListener('drain', onDrain);
              writable.removeListener('close', onClose);
              writable.removeListener('error', onError);
            };
            const onDrain = () => {
              cleanup();
              resolve();
            };
            const onClose = () => {
              cleanup();
              reject(new Error('Writable destroyed mid-transfer'));
            };
            const onError = (err: Error) => {
              cleanup();
              reject(err);
            };
            writable.once('drain', onDrain);
            writable.once('close', onClose);
            writable.once('error', onError);
          });
        }
        offset = end;
      }
      writable.end();
    }

    async remove(remotePath: string): Promise<void> {
      if (!mockState.files.has(remotePath)) {
        // basic-ftp surfaces a missing file on DELE as an FTPError with code 550.
        throw Object.assign(new Error(`550 File not found: ${remotePath}`), { code: 550 });
      }
      mockState.files.delete(remotePath);
    }

    async rename(from: string, to: string): Promise<void> {
      const data = mockState.files.get(from);
      if (!data) throw new Error(`File not found: ${from}`);
      mockState.files.set(to, data);
      mockState.files.delete(from);
    }

    async size(remotePath: string): Promise<number> {
      const data = mockState.files.get(remotePath);
      if (!data) throw Object.assign(new Error(`File not found: ${remotePath}`), { code: 550 });
      return mockState.sizeOverride ? mockState.sizeOverride(data.length) : data.length;
    }

    async list(dir: string): Promise<Array<{ name: string; isDirectory: boolean }>> {
      const entries: Array<{ name: string; isDirectory: boolean }> = [];
      // Files within the directory
      for (const key of mockState.files.keys()) {
        const parent = key.slice(0, key.lastIndexOf('/'));
        if (parent === dir) {
          entries.push({ name: key.slice(key.lastIndexOf('/') + 1), isDirectory: false });
        }
      }
      // Subdirectories
      for (const d of mockState.dirs) {
        const parent = d.slice(0, d.lastIndexOf('/'));
        if (parent === dir) {
          entries.push({ name: d.slice(d.lastIndexOf('/') + 1), isDirectory: true });
        }
      }
      return entries;
    }

    async ensureDir(dir: string): Promise<void> {
      mockState.dirs.add(dir);
    }

    close(): void {
      // no-op
    }
  }

  return { Client: MockClient };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<Record<string, unknown>> = {}, id = 'test-ftp'): ProviderConfig {
  return { id, type: 'ftp', adapterPackage: null, config: { host: 'localhost', port: 21, user: 'testuser', password: 'testpass', path: '/backup', secure: false, ...overrides } };
}

const TEST_LOCATIONS: ShardLocation[] = [
  {
    shard_index: 0,
    provider_id: 'test-ftp',
    provider_type: 'ftp',
    adapterPackage: null,
    connection_config: { host: 'localhost', path: '/backup' },
    required_inputs: [],
    remote_path: '/backup/vault/shard_0.bfs.1',
    shard_hash: 'a'.repeat(64),
  },
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

async function uploadBuf(provider: FtpProvider, filename: string, data: Buffer) {
  return provider.upload(filename, Readable.from(data), data.length);
}

async function downloadBuf(provider: FtpProvider, ref: { provider_id: string; path: string }): Promise<Buffer> {
  return streamToBuffer(await provider.download(ref));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('FtpProvider', () => {
  let provider: FtpProvider;

  beforeEach(() => {
    mockState.files.clear();
    mockState.dirs.clear();
    mockState.accessShouldFail = false;
    mockState.accessErrorCode = null;
    mockState.sentCommands = [];
    mockState.corruptOnUpload = null;
    mockState.uploadByteLossPlan = [];
    mockState.uploadAttempt = 0;
    mockState.sizeOverride = null;
    mockState.lastUploadChunkSizes = [];
    mockState.downloadChunkSize = null;
    mockState.lastDownloadBytesWritten = 0;

    const { io } = createMockProviderIO();
    provider = new FtpProvider(makeConfig(), io);
    provider.setVaultName('testvault');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── hardening (L2 path traversal, L6 idempotent delete) — parity with SSH ──
  describe('hardening', () => {
    it('should reject a download whose ref.path contains a traversal segment', async () => {
      await expect(provider.download({ provider_id: 'test-ftp', path: '../../evil' })).rejects.toThrow(UnsafePathError);
    });

    it('should reject a delete whose ref.path contains a traversal segment', async () => {
      await expect(provider.delete({ provider_id: 'test-ftp', path: '../evil' })).rejects.toThrow(UnsafePathError);
    });

    // delete is idempotent: an already-absent shard (FTP 550) is success, so prune
    // does not emit a false orphan warning for data that is already gone.
    it('should treat deleting an already-absent shard as success (idempotent)', async () => {
      await expect(provider.delete({ provider_id: 'test-ftp', path: 'shard_9.bfs.1' })).resolves.toBeUndefined();
    });

    // F1 — delete removes the header sidecar together with the shard, so prune
    // (which calls delete) leaves no orphaned hdr_ file behind on the medium.
    it('should remove the header sidecar together with the shard on delete', async () => {
      mockState.files.set('/backup/testvault/shard_0.bfs.1', Buffer.from('shard'));
      mockState.files.set('/backup/testvault/hdr_0.bfs.1', Buffer.from('hdr'));

      await provider.delete({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' });

      expect(mockState.files.has('/backup/testvault/shard_0.bfs.1')).toBe(false);
      expect(mockState.files.has('/backup/testvault/hdr_0.bfs.1')).toBe(false);
    });
  });

  // ─── constructor (lazy init — config validation via validateConfig) ─────

  it('should NOT throw when host is missing — config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new FtpProvider(makeConfig({ host: '' }), io)).not.toThrow();
  });

  it('should NOT throw when path is missing — config validation is lazy', () => {
    const { io } = createMockProviderIO();
    expect(() => new FtpProvider(makeConfig({ path: '' }), io)).not.toThrow();
  });

  it('should accept an empty config object for placeholder use in configure flows', () => {
    const { io } = createMockProviderIO();
    expect(() => new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io)).not.toThrow();
  });

  // ─── diagnostic logging (gated by `bfs --debug`) ─────────────────────────

  // Regression: `bfs verify` against an FTP provider used to emit "FTP
  // connecting to host:port" three times per shard via io.info(), polluting
  // every push/pull/verify run. The connect log must now route through
  // io.debug() so it stays silent unless the user passes --debug.
  it('should route the connection log through io.debug, not io.info', async () => {
    const { io, logs } = createMockProviderIO();
    const localProvider = new FtpProvider(makeConfig(), io);
    localProvider.setVaultName('testvault');

    await uploadBuf(localProvider, 'shard_0.bfs.1', Buffer.alloc(64, 1));

    const connectLogs = logs.filter((l) => l.message.includes('FTP connecting'));
    expect(connectLogs.length).toBeGreaterThan(0);
    for (const entry of connectLogs) {
      expect(entry.level).toBe('debug');
    }
    expect(logs.find((l) => l.level === 'info' && l.message.includes('FTP connecting'))).toBeUndefined();
  });

  // ─── plaintext-FTP warning (secure=false) ────────────────────────────────

  // A plain (non-FTPS) connection sends the password and shard bytes in the
  // clear; the user must be warned. The warning fires once per provider
  // instance, not once per shard, so a multi-shard push stays quiet after the
  // first connect.
  it('should warn once about plaintext FTP across multiple operations when secure=false', async () => {
    const { io, logs } = createMockProviderIO();
    const insecure = new FtpProvider(makeConfig({ secure: false }), io);
    insecure.setVaultName('testvault');

    await uploadBuf(insecure, 'shard_0.bfs.1', Buffer.alloc(64, 1));
    await uploadBuf(insecure, 'shard_1.bfs.1', Buffer.alloc(64, 2));

    const warns = logs.filter((l) => l.level === 'warn' && l.message.includes('localhost:21'));
    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toContain('not encrypted');
  });

  it('should not warn about plaintext FTP when secure=true', async () => {
    const { io, logs } = createMockProviderIO();
    const secure = new FtpProvider(makeConfig({ secure: true }), io);
    secure.setVaultName('testvault');

    await uploadBuf(secure, 'shard_0.bfs.1', Buffer.alloc(64, 1));

    const warns = logs.filter((l) => l.level === 'warn' && l.message.includes('not encrypted'));
    expect(warns).toHaveLength(0);
  });

  // ─── control-character rejection in path / vault name ────────────────────

  // CR/LF or NUL in a path sent over the FTP control channel could inject extra
  // FTP commands. Reject at config-validation time and again before any path is
  // assembled for CWD/STOR/LIST.
  it('validateConfig should reject a path containing a line break', () => {
    const { io } = createMockProviderIO();
    const p = new FtpProvider(makeConfig(), io);

    const errors = p.validateConfig({ host: 'h', port: 21, path: '/backup\r\nDELE secret' });

    expect(errors.some((e) => e.includes('control characters'))).toBe(true);
  });

  it('should reject a vault name containing a line break before any FTP operation', async () => {
    const { io } = createMockProviderIO();
    const p = new FtpProvider(makeConfig(), io);
    p.setVaultName('vault\r\nDELE secret');

    await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.alloc(8, 1))).rejects.toThrow(ProviderError);
  });

  it('should reject a vault name with a parent-traversal segment before any FTP operation', async () => {
    // vaultPath() guards only CR/LF/NUL today, so '../evil' builds an escaping
    // remote path ({base}/../evil) and the upload genuinely proceeds to STOR
    // there. The safe-segment rule is a BFS-core invariant (same as local-fs),
    // so traversal must throw the core UnsafePathError before any FTP command.
    const { io } = createMockProviderIO();
    const p = new FtpProvider(makeConfig(), io);
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

    expect(ref.provider_id).toBe('test-ftp');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64);
  });

  // ─── post-upload verification (defense against silent FTP corruption) ─────

  it('should throw ProviderError with size diff when the server stored fewer bytes than uploaded', async () => {
    mockState.corruptOnUpload = (buf) => buf.subarray(0, buf.length - 1);
    const data = Buffer.alloc(256, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).rejects.toThrow(/size mismatch/i);
  });

  // Regression: vsftpd on writeback-cached filesystems briefly reports a
  // stale `SIZE` for newly created files. The provider must poll SIZE a
  // few times before declaring failure.
  it('should accept upload when first SIZE is stale but stabilizes on retry', async () => {
    let calls = 0;
    mockState.sizeOverride = (actual) => {
      calls += 1;
      return calls === 1 ? actual - 100 : actual;
    };
    const data = Buffer.alloc(256, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).resolves.toBeDefined();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(mockState.uploadAttempt).toBe(1);
  });

  // Regression: reproduces the user's vsftpd/Docker scenario where the
  // first STOR sporadically truncates the data connection (verified
  // independently with Windows Explorer) and the next STOR delivers the
  // full payload. The provider must retry STOR end-to-end.
  it('should succeed via STOR retry when the first STOR loses bytes', async () => {
    mockState.uploadByteLossPlan = [25304];
    const data = Buffer.alloc(300_000, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).resolves.toBeDefined();

    expect(mockState.uploadAttempt).toBe(2);
    const stored = mockState.files.get('/backup/testvault/shard_0.bfs.1');
    expect(stored?.length).toBe(data.length);
  });

  // Regression: persistent truncation (e.g. ASCII mode silently rewriting
  // bytes) keeps returning the same wrong size across all attempts. The
  // provider must give up after MAX_UPLOAD_ATTEMPTS and surface the diff.
  it('should fail after exhausting STOR retries on persistent truncation', async () => {
    mockState.uploadByteLossPlan = [1, 1, 1, 1];
    const data = Buffer.alloc(256, 0xab);

    await expect(uploadBuf(provider, 'shard_0.bfs.1', data)).rejects.toThrow(/after 3 attempts/i);
    expect(mockState.uploadAttempt).toBe(3);
  });

  it('should issue TYPE I after access on every withClient session', async () => {
    const data = Buffer.from('binary');
    await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(mockState.sentCommands).toContain('TYPE I');
  });

  it('should split a multi-chunk-sized payload across multiple stream chunks', async () => {
    // Regression: `Readable.from(buffer)` pushes the whole buffer as one
    // chunk, which has been observed to silently truncate on real FTP
    // servers (vsftpd / Docker) for multi-MB uploads. The provider must
    // emit fixed-size chunks (~64 KB) to cooperate with TCP backpressure.
    const data = Buffer.alloc(200 * 1024, 0xab);

    await uploadBuf(provider, 'shard_0.bfs.1', data);

    expect(mockState.lastUploadChunkSizes.length).toBeGreaterThan(1);
    const maxChunk = Math.max(...mockState.lastUploadChunkSizes);
    expect(maxChunk).toBeLessThanOrEqual(64 * 1024);
  });

  // ─── list ────────────────────────────────────────────────────────────────

  it('should list all uploaded files', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('b'));

    const refs = await provider.list();
    const names = refs.map((r) => r.path).sort();

    expect(names).toEqual(['shard_0.bfs.1', 'shard_1.bfs.1']);
  });

  it('should filter list by prefix', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_0.bfs.2', Buffer.from('b'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('c'));

    const refs = await provider.list('shard_0');

    expect(refs.map((r) => r.path).sort()).toEqual(['shard_0.bfs.1', 'shard_0.bfs.2']);
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
    expect(refs.map((r) => r.path)).not.toContain('shard_0.bfs.1');
  });

  // Deleting an already-absent shard is idempotent (success), not an error — see
  // the "hardening" block (L6). It must not raise a false prune orphan warning.

  // ─── healthCheck ─────────────────────────────────────────────────────────

  it('should return true when connection succeeds', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false when connection fails', async () => {
    mockState.accessShouldFail = true;
    expect(await provider.healthCheck()).toBe(false);
  });

  // ─── authenticate ────────────────────────────────────────────────────────

  it('should not throw when connection succeeds', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should throw ProviderError when connection fails', async () => {
    mockState.accessShouldFail = true;
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
    const names = refs.map((r) => r.path);
    expect(names).not.toContain('shard_0.bfs.1.tmp');
    expect(names).toContain('shard_0.bfs.1');
  });

  // ─── updateShardHeader ───────────────────────────────────────────────────

  it('should update shard header, keep payload intact, and recompute checksum', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalHeader = makeHeader({ shard_index: 0 });
    const originalShard = buildShard(originalHeader, payload);

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

  it('should throw ProviderError with size diff when updateShardHeader stores fewer bytes than sent', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalHeader = makeHeader({ shard_index: 0 });
    const originalShard = buildShard(originalHeader, payload);
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    // Activate corruption only for the rewrite triggered by updateShardHeader.
    mockState.corruptOnUpload = (buf) => buf.subarray(0, buf.length - 1);

    const updatedHeader = makeHeader({ shard_index: 0 });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await expect(provider.updateShardHeader(ref, newHeaderData)).rejects.toThrow(/size mismatch/i);
  });

  // Regression: updateShardHeader rewrites the entire shard in place. The
  // same sporadic vsftpd/Docker truncation that hits upload() can hit it
  // here, and the same retry contract must apply.
  it('should retry updateShardHeader when the first rewrite loses bytes', async () => {
    const payload = Buffer.alloc(64 * 1024, 0xab);
    const originalHeader = makeHeader({ shard_index: 0 });
    const originalShard = buildShard(originalHeader, payload);
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    const initialAttemptCount = mockState.uploadAttempt;
    // First rewrite STOR drops 4096 B; second rewrite is clean.
    mockState.uploadByteLossPlan = [...new Array(initialAttemptCount).fill(0), 4096];

    const updatedHeader = makeHeader({ shard_index: 0, location_map: [{ ...TEST_LOCATIONS[0], remote_path: '/new/path/shard_0.bfs.1', shard_hash: 'c'.repeat(64) }] });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await expect(provider.updateShardHeader(ref, newHeaderData)).resolves.toBeDefined();

    expect(mockState.uploadAttempt).toBe(initialAttemptCount + 2);
    const stored = mockState.files.get('/backup/testvault/shard_0.bfs.1');
    const { header: h, payloadStream } = await parseShardHeaderFromStream(Readable.from(stored ?? Buffer.alloc(0)));
    const p = await streamToBuffer(payloadStream);
    expect(p).toEqual(payload);
    expect(h.location_map[0].remote_path).toBe('/new/path/shard_0.bfs.1');
  });

  // ─── listVaults ──────────────────────────────────────────────────────────

  it('should list vault directories from basePath', async () => {
    mockState.dirs.add('/backup/vault-a');
    mockState.dirs.add('/backup/vault-b');

    const { io } = createMockProviderIO();
    const p = new FtpProvider(makeConfig(), io);
    const vaults = await p.listVaults();

    expect(vaults.sort()).toEqual(['vault-a', 'vault-b']);
  });

  // ─── getSize ──────────────────────────────────────────────────────────────

  describe('getSize', () => {
    it('should return shard size via SIZE without transferring the payload', async () => {
      const data = Buffer.alloc(8192, 0x55);
      await uploadBuf(provider, 'shard_0.bfs.1', data);

      const size = await provider.getSize({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' });

      expect(size).toBe(8192);
      // No download bytes flowed through the data channel.
      expect(mockState.lastDownloadBytesWritten).toBe(0);
    });

    it('should throw ProviderError when the shard is missing', async () => {
      await expect(provider.getSize({ provider_id: 'test-ftp', path: 'missing.bfs.1' })).rejects.toThrow(ProviderError);
    });
  });

  // ─── downloadHeader ───────────────────────────────────────────────────────

  describe('downloadHeader', () => {
    it('should pull the whole file when size <= maxBytes', async () => {
      const data = Buffer.from('tiny');
      await uploadBuf(provider, 'shard_0.bfs.1', data);

      const head = await provider.downloadHeader({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, 1024);

      expect(head.length).toBe(4);
      expect(head.toString()).toBe('tiny');
    });

    it('should abort the transfer after maxBytes for a larger shard', async () => {
      // 200 KB shard, ask for 8 KB. Mock streams in 4 KB chunks so we can
      // verify the transfer stopped early instead of pulling the whole file.
      const data = Buffer.alloc(200 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      await uploadBuf(provider, 'shard_0.bfs.1', data);
      mockState.downloadChunkSize = 4096;

      const head = await provider.downloadHeader({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, 8192);

      expect(head.length).toBe(8192);
      expect(Buffer.compare(head, data.subarray(0, 8192))).toBe(0);
      // Transferred ≤ one extra chunk past maxBytes — never the whole file.
      expect(mockState.lastDownloadBytesWritten).toBeLessThanOrEqual(8192 + 4096);
      expect(mockState.lastDownloadBytesWritten).toBeLessThan(data.length);
    });

    it('should throw ProviderError for a missing shard', async () => {
      await expect(provider.downloadHeader({ provider_id: 'test-ftp', path: 'missing.bfs.1' }, 1024)).rejects.toThrow(ProviderError);
    });

    it('should reject maxBytes <= 0', async () => {
      await expect(provider.downloadHeader({ provider_id: 'test-ftp', path: 'whatever' }, 0)).rejects.toThrow(ProviderError);
    });
  });

  // ─── configureInteractive ─────────────────────────────────────────────────

  describe('configureInteractive', () => {
    it('should prompt for all fields and return a complete config', async () => {
      const { io } = createMockProviderIO({ 'FTP host:': 'ftp.example.com', 'Port (default 21):': '2121', 'Username:': 'alice', 'Password:': 'supersecret', 'Base path on server:': '/backup', 'Use FTPS (secure connection)?': 'true' });
      const { io: ctorIO } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toEqual({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'supersecret', path: '/backup', secure: true });
    });

    it('should default port to 21 when user enters empty string', async () => {
      const { io } = createMockProviderIO({ 'FTP host:': 'ftp.example.com', 'Port (default 21):': '', 'Username:': 'alice', 'Password:': 'secret', 'Base path on server:': '/backup', 'Use FTPS (secure connection)?': 'false' });
      const { io: ctorIO } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config.port).toBe(21);
    });
  });

  // ─── configureFromFlags ───────────────────────────────────────────────────

  describe('configureFromFlags', () => {
    it('should throw ProviderError when no config source is given', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput())).rejects.toThrow(ProviderError);
    });

    // Regression: an earlier message ("use --host or --config-file") suggested
    // those flags were `bfs init` options. They are adapter flags that must be
    // inside the shell-quoted --provider spec. The error must show that.
    it('should explain --provider spec syntax when host is missing', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--path', '/backup'] }))).rejects.toThrow(/--provider "ftp:nas --host/);
    });

    it('should explain --provider spec syntax when path is missing', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'nas'] }))).rejects.toThrow(/--provider "ftp:nas --path/);
    });

    // ─── Inline flags ───────────────────────────────────────────────────────

    it('should accept full inline FTP spec', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'ftp.example.com', '--port', '2121', '--user', 'alice', '--password', 'secret', '--path', '/backup', '--secure', 'true'] }));

      expect(config).toEqual({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true });
    });

    it('should default port to 21 when --port omitted', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', '/b'] }));

      expect(config.port).toBe(21);
      expect(config.secure).toBe(false);
    });

    it('should reject --port outside 1..65535', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', '/b', '--port', '99999'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject non-numeric --port', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', '/b', '--port', 'abc'] }))).rejects.toThrow(ProviderError);
    });

    it.each([
      ['true', true],
      ['1', true],
      ['yes', true],
      ['YES', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['No', false],
    ])('should parse --secure %s as %s', async (input, expected) => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', '/b', '--secure', input] }));

      expect(config.secure).toBe(expected);
    });

    it('should reject unrecognized --secure value', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', '/b', '--secure', 'maybe'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject inline --path that is not absolute', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--host', 'h', '--path', 'relative/x'] }))).rejects.toThrow(ProviderError);
    });

    it('should reject when --host is missing entirely', async () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--path', '/b'] }))).rejects.toThrow(ProviderError);
    });

    it('should let inline flags override --config-file fields', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'ftp.example.com', port: 21, user: 'alice', password: 'json-pass', path: '/backup', secure: false }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file, '--password', 'override', '--secure', 'true'] }));

      expect(config).toEqual({ host: 'ftp.example.com', port: 21, user: 'alice', password: 'override', path: '/backup', secure: true });
    });

    it('should parse a valid JSON config file', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config).toEqual({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true });
    });

    it('should coerce numeric port from string ("21")', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'ftp.example.com', port: '21', user: 'u', password: 'p', path: '/b', secure: false }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }));

      expect(config.port).toBe(21);
    });

    it('should throw on malformed JSON', async () => {
      const file = await writeJsonConfig('{ not valid json');
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when JSON is an array (not a plain object)', async () => {
      const file = await writeJsonConfig(JSON.stringify([1, 2, 3]));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when host is missing from JSON', async () => {
      const file = await writeJsonConfig(JSON.stringify({ port: 21, path: '/b' }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when path is not absolute', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'h', port: 21, path: 'relative' }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when port is out of range', async () => {
      const file = await writeJsonConfig(JSON.stringify({ host: 'h', port: 99999, path: '/b' }));
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });
  });

  // ─── validateConfig ───────────────────────────────────────────────────────

  describe('validateConfig', () => {
    it('should return [] for a valid config', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      expect(p.validateConfig({ host: 'ftp.example.com', port: 21, user: 'alice', password: 'secret', path: '/backup', secure: false })).toEqual([]);
    });

    it('should report missing or empty host', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ port: 21, path: '/backup' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => /host/i.test(e))).toBe(true);
    });

    it('should report out-of-range port', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'ftp.example.com', port: 99999, path: '/backup' });
      expect(errors.some((e) => /port/i.test(e))).toBe(true);
    });

    it('should report path not starting with /', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ host: 'ftp.example.com', port: 21, path: 'backup' });
      expect(errors.some((e) => /path/i.test(e))).toBe(true);
    });
  });

  // ─── describeConfig ───────────────────────────────────────────────────────

  describe('describeConfig', () => {
    it('should include host, port, user, path, secure', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true });

      expect(desc).toContain('ftp.example.com');
      expect(desc).toContain('2121');
      expect(desc).toContain('alice');
      expect(desc).toContain('/backup');
    });

    it('should mask the password field — no plaintext, asterisks present', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ host: 'ftp.example.com', port: 21, user: 'alice', password: 'supersecret', path: '/backup', secure: false });

      expect(desc).not.toContain('supersecret');
      expect(desc).toMatch(/\*{3,}/);
    });
  });

  // ─── getSecretFields ──────────────────────────────────────────────────────

  describe('getSecretFields', () => {
    it('should return ["password"]', () => {
      const { io } = createMockProviderIO();
      const p = new FtpProvider({ id: 'stub', type: 'ftp', adapterPackage: null, config: {} }, io);
      expect(p.getSecretFields()).toEqual(['password']);
    });
  });

  // ─── probeConnection ──────────────────────────────────────────────────────

  describe('probeConnection', () => {
    it('should upload, download, compare, and clean up — leaving no residue', async () => {
      await provider.probeConnection();

      const refs = await provider.list();
      expect(refs).toEqual([]);
    });

    it('should throw ProviderError when the FTP connection fails', async () => {
      mockState.accessShouldFail = true;
      await expect(provider.probeConnection()).rejects.toThrow(ProviderError);
    });
  });

  // ─── usesSidecar / verifyShard / sidecar methods ───────────────────────────

  describe('header storage strategy + verifyShard', () => {
    const IDENTITY = { vault_id: '550e8400-e29b-41d4-a716-446655440000', shard_index: 0, version: 1 };

    it('should return ok for a matching shard identity', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader(), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result).toEqual({ ok: true });
    });

    it('should report not_found (FTP 550) for a missing shard', async () => {
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.999' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_found');
    });

    it('should report auth_failed (FTP 530) when authentication is rejected', async () => {
      mockState.accessErrorCode = 530;
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('auth_failed');
    });

    // Regression: a transport failure with no recognized reply code (here a
    // transient 421, but equally a code-less ECONNREFUSED/TLS error) must be
    // reported as unverifiable, not thrown — so one offline host never aborts a
    // whole multi-provider verification. Mirrors LocalFsProvider.
    it('should report unverifiable on a transport error without a recognized reply code', async () => {
      mockState.accessErrorCode = 421;
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unverifiable');
    });

    it('should report mismatch on a wrong expected version', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader({ version: 1 }), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, { ...IDENTITY, version: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('mismatch');
        expect(result.detail).toContain('version');
      }
    });

    it('should report corrupted for a truncated shard', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', Buffer.alloc(8));
      const result = await provider.verifyShard({ provider_id: 'test-ftp', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('corrupted');
    });
  });

  // ─── connectForRecovery — show the host BEFORE collecting the secret ────────
  //
  // The recovery credential-phishing defence is an optional provider hook:
  //   connectForRecovery(io, pool): Promise<string | null>
  // Contract: the provider MUST surface the connection target (host:port) to the
  // operator BEFORE it collects or sends any secret, may reuse a secret from the
  // supplied pool, connects + authenticates itself, and returns the secret to add
  // to the pool (labelled with its id) or null when there is no reusable secret.
  // Declining the host MUST throw before any secret is collected.
  describe('connectForRecovery', () => {
    type RecoverySecret = { value: string; origin: string };
    type WithRecovery = FtpProvider & { connectForRecovery(io: ProviderIO, pool: readonly RecoverySecret[]): Promise<string | null> };

    /**
     * Builds a recording io: askSecret returns `secret` and pushes a marker into
     * `order` so a test can assert the host was shown (info/confirm) before the
     * secret was requested.
     */
    function recordingIo(secret: string): { io: ProviderIO; order: string[] } {
      const order: string[] = [];
      const io: ProviderIO = {
        lang: 'en',
        workDir: process.cwd(),
        async ask(): Promise<string> {
          return '';
        },
        async askSecret(): Promise<string> {
          order.push('askSecret');
          return secret;
        },
        async confirm(message: string): Promise<boolean> {
          order.push(`confirm:${message}`);
          return true;
        },
        async choose(_m: string, options: string[]): Promise<string> {
          return options[0] ?? '';
        },
        info(message: string): void {
          order.push(`info:${message}`);
        },
        debug(): void {},
        warn(): void {},
        progress(): void {},
      };
      return { io, order };
    }

    it('should show host:port before collecting the password, then return the typed secret', async () => {
      const { io, order } = recordingIo('victim-pw');
      const ftpProvider = new FtpProvider(makeConfig({ host: '203.0.113.7', port: 2121, user: 'victim' }), io) as WithRecovery;
      ftpProvider.setVaultName('testvault');

      const returned = await ftpProvider.connectForRecovery(io, []);

      // The host:port must appear in an io call (info/confirm) BEFORE askSecret.
      const askIndex = order.indexOf('askSecret');
      const hostIndex = order.findIndex((e) => e.includes('203.0.113.7:2121') || e.includes('203.0.113.7'));
      expect(hostIndex).toBeGreaterThanOrEqual(0);
      expect(askIndex).toBeGreaterThanOrEqual(0);
      expect(hostIndex).toBeLessThan(askIndex);
      // The collected secret is returned so the pool can reuse it across siblings.
      expect(returned).toBe('victim-pw');
    });

    it('should still show the host when reusing a pooled secret', async () => {
      const { io, order } = recordingIo('unused-fresh');
      const ftpProvider = new FtpProvider(makeConfig({ host: '198.51.100.4', port: 21, user: 'victim' }), io) as WithRecovery;
      ftpProvider.setVaultName('testvault');

      const pool: RecoverySecret[] = [{ value: 'pooled-pw', origin: 'p0' }];
      await ftpProvider.connectForRecovery(io, pool);

      const hostShown = order.some((e) => e.includes('198.51.100.4'));
      expect(hostShown).toBe(true);
    });

    // Decline path: confirm → false must throw before askSecret is reached, so
    // the secret is never collected — a forged host cannot phish the password.
    it('should refuse and collect no secret when the operator declines the host', async () => {
      const order: string[] = [];
      let askSecretCalled = false;
      const io: ProviderIO = {
        lang: 'en',
        workDir: process.cwd(),
        async ask(): Promise<string> {
          return '';
        },
        async askSecret(): Promise<string> {
          askSecretCalled = true;
          order.push('askSecret');
          return 'never-collected';
        },
        async confirm(message: string): Promise<boolean> {
          order.push(`confirm:${message}`);
          return false;
        },
        async choose(_m: string, options: string[]): Promise<string> {
          return options[0] ?? '';
        },
        info(message: string): void {
          order.push(`info:${message}`);
        },
        debug(): void {},
        warn(): void {},
        progress(): void {},
      };
      const ftpProvider = new FtpProvider(makeConfig({ host: '203.0.113.7', port: 2121, user: 'victim' }), io) as WithRecovery;
      ftpProvider.setVaultName('testvault');

      // The host:port is shown in the confirm prompt, the call rejects with a
      // ProviderError, and askSecret is never invoked — no secret leaves the box.
      await expect(ftpProvider.connectForRecovery(io, [])).rejects.toBeInstanceOf(ProviderError);
      expect(askSecretCalled).toBe(false);
      const declinedAt = order.findIndex((e) => e.startsWith('confirm:') && e.includes('203.0.113.7'));
      expect(declinedAt).toBeGreaterThanOrEqual(0);
    });
  });
});

// Header sidecar (BFSH): FTP uploads a relocated shard's updated header as a
// small remote `hdr_i.bfs.V` file instead of downloading + re-uploading the
// whole shard (FTP has no partial write) — a `bfs repair` location change costs
// KB over the wire, not the full multi-* payload. The `hdr_` prefix keeps it out
// of every `list('shard_')` scan structurally.
describe('FtpProvider — header sidecar (BFSH)', () => {
  let provider: FtpProvider;
  const shardRef = { provider_id: 'test-ftp', path: 'shard_0.bfs.1' };
  const SIDECAR_KEY = '/backup/testvault/hdr_0.bfs.1';

  beforeEach(() => {
    mockState.files.clear();
    mockState.dirs.clear();
    mockState.accessShouldFail = false;
    mockState.accessErrorCode = null;
    mockState.sentCommands = [];
    mockState.corruptOnUpload = null;
    mockState.uploadByteLossPlan = [];
    mockState.uploadAttempt = 0;
    mockState.sizeOverride = null;
    mockState.lastUploadChunkSizes = [];
    mockState.downloadChunkSize = null;
    mockState.lastDownloadBytesWritten = 0;

    const { io } = createMockProviderIO();
    provider = new FtpProvider(makeConfig(), io);
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
