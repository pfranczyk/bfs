import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, UnsafePathError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import { buildShard, parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { CliProviderInput, ProviderConfig, ShardHeader, ShardLocation } from '../../src/types/index.js';

function cliInput(overrides: Partial<CliProviderInput> = {}): CliProviderInput {
  return { name: overrides.name ?? 'test', rawArgs: overrides.rawArgs ?? [] };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(basePath: string, id = 'test-local'): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: basePath } };
}

const TEST_LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'test-local', provider_type: 'local', adapterPackage: null, connection_config: { path: '/tmp/test' }, required_inputs: [], remote_path: '/tmp/test/vault/shard_0.bfs.1', shard_hash: 'a'.repeat(64) },
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

/** Upload helper: wraps Buffer in Readable.from() as required by the new interface. */
async function uploadBuf(provider: LocalFsProvider, filename: string, data: Buffer) {
  return provider.upload(filename, Readable.from(data), data.length);
}

/** Download helper: collects the Readable stream into a Buffer. */
async function downloadBuf(provider: LocalFsProvider, ref: { provider_id: string; path: string }): Promise<Buffer> {
  return streamToBuffer(await provider.download(ref));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LocalFsProvider', () => {
  let tmpDir: string;
  let provider: LocalFsProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-'));
    const { io } = createMockProviderIO();
    provider = new LocalFsProvider(makeConfig(tmpDir), io);
    provider.setVaultName('testvault');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── upload / download ────────────────────────────────────────────────────

  it('should upload and download identical data', async () => {
    const data = Buffer.from('hello, shard data');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);
    expect(downloaded).toEqual(data);
  });

  it('should preserve binary data on upload/download', async () => {
    const data = Buffer.alloc(512);
    for (let i = 0; i < 512; i++) data[i] = i % 256;
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);
    expect(downloaded).toEqual(data);
  });

  it('should return hash in RemoteRef after upload', async () => {
    const data = Buffer.from('test');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    expect(ref.provider_id).toBe('test-local');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64); // SHA-256 hex
  });

  // ─── list ─────────────────────────────────────────────────────────────────

  it('should list uploaded files', async () => {
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

  it('should return empty list when vault directory does not exist', async () => {
    const { io } = createMockProviderIO();
    const freshProvider = new LocalFsProvider(makeConfig(tmpDir), io);
    freshProvider.setVaultName('nonexistent-vault');
    const refs = await freshProvider.list();
    expect(refs).toEqual([]);
  });

  // ─── delete ───────────────────────────────────────────────────────────────

  it('should delete a file and remove it from list', async () => {
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('data'));
    await provider.delete(ref);
    const refs = await provider.list();
    expect(refs.map((r) => r.path)).not.toContain('shard_0.bfs.1');
  });

  // delete is idempotent: an already-absent shard is success (parity with
  // FTP/SSH), so a resumed prune or an out-of-band removal does not raise a
  // false "possible orphan" warning for data that is already gone.
  it('should treat deleting an already-absent shard as success (idempotent)', async () => {
    await expect(provider.delete({ provider_id: 'test-local', path: 'nonexistent.bfs.1' })).resolves.toBeUndefined();
  });

  // ─── healthCheck ──────────────────────────────────────────────────────────

  it('should return true for an existing path', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false for a non-existent path', async () => {
    const { io } = createMockProviderIO();
    const badProvider = new LocalFsProvider(makeConfig('/nonexistent/path/xyz'), io);
    expect(await badProvider.healthCheck()).toBe(false);
  });

  // ─── authenticate ─────────────────────────────────────────────────────────

  it('should succeed silently when path already exists', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should create directory when confirm=true and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'new-subdir');
    const { io } = createMockProviderIO({ [`Path "${newPath}" does not exist. Create it?`]: 'true' });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await p.authenticate();
    const stat = await fs.stat(newPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should throw when confirm=false and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'refused-dir');
    const { io } = createMockProviderIO({ [`Path "${newPath}" does not exist. Create it?`]: 'false' });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await expect(p.authenticate()).rejects.toThrow(ProviderError);
  });

  // Non-interactive (--ci / --bootstrap / no TTY): a missing base path must be
  // created without prompting. A prompt has nobody to answer, so asking would
  // abort a scripted repair/recovery that restores to a machine where the
  // source paths don't exist. The mock has NO confirm answer, so if the create
  // prompt were still reached it would resolve false and this would reject —
  // resolving proves the prompt was bypassed.
  it('should create the path without prompting when io is non-interactive', async () => {
    const newPath = path.join(tmpDir, 'ci-created-dir');
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const p = new LocalFsProvider(makeConfig(newPath), io);

    await expect(p.authenticate()).resolves.toBeUndefined();

    const stat = await fs.stat(newPath);
    expect(stat.isDirectory()).toBe(true);
  });

  // ─── rename ───────────────────────────────────────────────────────────────

  it('should rename a file and make it available under the new name', async () => {
    const tmpBuf = Buffer.from('payload');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1.tmp', tmpBuf);
    const newRef = await provider.rename(ref, 'shard_0.bfs.1');
    expect(newRef.path).toBe('shard_0.bfs.1');

    const downloaded = await downloadBuf(provider, newRef);
    expect(downloaded).toEqual(Buffer.from('payload'));

    const refs = await provider.list();
    const names = refs.map((r) => r.path);
    expect(names).not.toContain('shard_0.bfs.1.tmp');
    expect(names).toContain('shard_0.bfs.1');
  });

  // ─── updateShardHeader ────────────────────────────────────────────────────

  it('should update shard header, keep payload intact, and recompute trailing checksum', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalHeader = makeHeader({ shard_index: 0 });
    const originalShard = buildShard(originalHeader, payload);

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    // Build a new header with updated location info (simulating a heal operation)
    const updatedHeader = makeHeader({ shard_index: 0, location_map: [{ ...TEST_LOCATIONS[0], remote_path: '/new/path/shard_0.bfs.1', shard_hash: 'c'.repeat(64) }] });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    // Extract just the header bytes (everything before the payload+checksum)
    // We built a shard with empty payload so: [header][0 payload][32 checksum]
    // → header = newShardForHeader.subarray(0, length - 32)
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await provider.updateShardHeader(ref, newHeaderData);

    const updatedBuf = await downloadBuf(provider, ref);

    // Should parse without error (checksum must be valid)
    const { header: h, payloadStream } = await parseShardHeaderFromStream(Readable.from(updatedBuf));
    const p = await streamToBuffer(payloadStream);

    // Payload must be untouched
    expect(p).toEqual(payload);

    // Header must reflect the update
    expect(h.location_map[0].remote_path).toBe('/new/path/shard_0.bfs.1');
  });

  // ─── listVaults ───────────────────────────────────────────────────────────

  it('should list vault directories under basePath', async () => {
    await fs.mkdir(path.join(tmpDir, 'vault-a'));
    await fs.mkdir(path.join(tmpDir, 'vault-b'));
    // Also place a regular file — must be excluded
    await fs.writeFile(path.join(tmpDir, 'not-a-vault.txt'), 'x');

    const { io } = createMockProviderIO();
    const p = new LocalFsProvider(makeConfig(tmpDir), io);
    const vaults = await p.listVaults();
    expect(vaults.sort()).toEqual(['vault-a', 'vault-b']);
  });

  it('should return empty array when basePath does not exist', async () => {
    const { io } = createMockProviderIO();
    const p = new LocalFsProvider(makeConfig('/nonexistent/xyz'), io);
    expect(await p.listVaults()).toEqual([]);
  });

  // ─── getSize ──────────────────────────────────────────────────────────────

  describe('getSize', () => {
    it('should return the byte size of an existing shard via fs.stat', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      const data = Buffer.alloc(1024, 0x42);
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const size = await p.getSize({ provider_id: 'test-local', path: 'shard_0.bfs.1' });

      expect(size).toBe(1024);
    });

    it('should throw ProviderError when the shard is missing', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.getSize({ provider_id: 'test-local', path: 'shard_missing.bfs.1' })).rejects.toThrow(ProviderError);
    });
  });

  // ─── downloadHeader ───────────────────────────────────────────────────────

  describe('downloadHeader', () => {
    it('should return exactly maxBytes for a shard larger than the limit', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      // 100 KB shard, ask for 1 KB.
      const data = Buffer.alloc(100 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const head = await p.downloadHeader({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, 1024);

      expect(head.length).toBe(1024);
      expect(Buffer.compare(head, data.subarray(0, 1024))).toBe(0);
    });

    it('should return the entire file when maxBytes exceeds file size', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      const data = Buffer.from('short');
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const head = await p.downloadHeader({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, 1_000_000);

      expect(head.length).toBe(5);
      expect(head.toString()).toBe('short');
    });

    it('should throw ProviderError for missing shard', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.downloadHeader({ provider_id: 'test-local', path: 'missing.bfs.1' }, 1024)).rejects.toThrow(ProviderError);
    });

    it('should reject maxBytes <= 0', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.downloadHeader({ provider_id: 'test-local', path: 'x' }, 0)).rejects.toThrow(ProviderError);
    });
  });

  // ─── configureInteractive ─────────────────────────────────────────────────

  describe('configureInteractive', () => {
    it('should ask for base path and return config', async () => {
      const { io } = createMockProviderIO({ 'Base directory path:': tmpDir });
      const { io: ctorIO } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toEqual({ path: tmpDir });
    });
  });

  // ─── configureFromFlags ───────────────────────────────────────────────────

  describe('configureFromFlags', () => {
    it('should default to ~/.bfs-local/<name> when filePath is null', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'my-backup' }));

      expect(config.path).toBe(path.join(os.homedir(), '.bfs-local', 'my-backup'));
    });

    it('should read JSON file containing { path } when filePath is given', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
      const file = path.join(dir, 'cfg.json');
      await fs.writeFile(file, JSON.stringify({ path: '/custom/path' }), 'utf8');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }));

      expect(config).toEqual({ path: '/custom/path' });
    });

    it('should throw ProviderError when JSON lacks a non-empty "path"', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
      const file = path.join(dir, 'cfg.json');
      await fs.writeFile(file, JSON.stringify({ path: '' }), 'utf8');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
      // Regression: error must mention the missing "path" field clearly so
      // user knows the JSON shape, not the unrelated init-level flag layout.
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(/non-empty "path"/);
    });

    it('should throw on malformed JSON', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
      const file = path.join(dir, 'cfg.json');
      await fs.writeFile(file, 'not json', 'utf8');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when JSON is not a plain object', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
      const file = path.join(dir, 'cfg.json');
      await fs.writeFile(file, JSON.stringify([1, 2]), 'utf8');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    // ─── Inline --path ──────────────────────────────────────────────────────

    it('should accept inline --path with absolute path', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', '/abs/custom'] }));

      expect(config).toEqual({ path: '/abs/custom' });
    });

    it('should resolve a relative --path against io.workDir', async () => {
      const { io } = createMockProviderIO({}, '/work');
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', './rel'] }));

      expect(config).toEqual({ path: path.resolve('/work', './rel') });
    });

    it('should let inline --path win over --config-file', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
      const file = path.join(dir, 'cfg.json');
      await fs.writeFile(file, JSON.stringify({ path: '/from/json' }), 'utf8');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', '/from/inline', '--config-file', file] }));

      expect(config).toEqual({ path: '/from/inline' });
    });
  });

  // ─── validateConfig ───────────────────────────────────────────────────────

  describe('validateConfig', () => {
    it('should return [] for a non-empty path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      expect(p.validateConfig({ path: tmpDir })).toEqual([]);
    });

    it('should report missing path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({});
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => /path/i.test(e))).toBe(true);
    });

    it('should report empty-string path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ path: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ─── describeConfig ───────────────────────────────────────────────────────

  describe('describeConfig', () => {
    it('should include the path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ path: '/my/backup' });

      expect(desc).toContain('/my/backup');
    });
  });

  // ─── getSecretFields ──────────────────────────────────────────────────────

  describe('getSecretFields', () => {
    it('should return []', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      expect(p.getSecretFields()).toEqual([]);
    });
  });

  // ─── probeConnection ──────────────────────────────────────────────────────

  describe('probeConnection', () => {
    it('should write/read/compare/unlink — leaving no residue in vault dir', async () => {
      await provider.probeConnection();

      const refs = await provider.list();
      expect(refs).toEqual([]);
    });

    it('should throw ProviderError when basePath is unwritable', async () => {
      const badPath = path.join(os.tmpdir(), `bfs-unwritable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      // NOTE: path simply does not exist and its parent is writable —
      // but probeConnection tries to create vaultDir under a non-existent
      // root; on Windows this surfaces as EACCES/ENOENT. On Linux it may
      // succeed via recursive mkdir. To force failure, use a path under a
      // non-existent root whose parent chain includes an invalid segment.
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'x', type: 'local', adapterPackage: null, config: { path: path.join(badPath, 'nope') } }, io);
      p.setVaultName('testvault');

      // Create a FILE at badPath so mkdir underneath it fails with ENOTDIR
      await fs.writeFile(badPath, 'blocker');
      try {
        await expect(p.probeConnection()).rejects.toThrow(ProviderError);
      } finally {
        await fs.rm(badPath, { force: true });
      }
    });
  });

  // ─── usesSidecar / verifyShard / sidecar methods ───────────────────────────

  describe('header storage strategy + verifyShard', () => {
    const IDENTITY = { vault_id: '550e8400-e29b-41d4-a716-446655440000', shard_index: 0, version: 1 };

    it('should return ok for a matching shard identity', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader(), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result).toEqual({ ok: true });
    });

    it('should report not_found for a missing shard', async () => {
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.999' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_found');
    });

    // Regression: a present-but-unreadable shard must classify as unverifiable,
    // not not_found. A directory at the shard path is readable (fs.access R_OK
    // passes) but reads as EISDIR — the cause must drive the classification, so
    // a non-ENOENT failure stays unverifiable without a second stat.
    it('should report unverifiable when the shard path is present but unreadable', async () => {
      await uploadBuf(provider, 'shard_keep.bfs.1', Buffer.from('seed')); // creates the vault dir
      await fs.mkdir(path.join(tmpDir, 'testvault', 'shard_0.bfs.1'), { recursive: true });

      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unverifiable');
    });

    it('should report mismatch on a wrong expected version', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader({ version: 1 }), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, { ...IDENTITY, version: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('mismatch');
        expect(result.detail).toContain('version');
      }
    });

    it('should report corrupted for a truncated shard', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', Buffer.alloc(8));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('corrupted');
    });
  });

  // ─── vault name runtime guard (path traversal) ──────────────────────────────
  // A vault name becomes a path segment under basePath ({basePath}/{vaultName}/
  // shard_...). With no guard the name escapes the root for real: list() reads
  // the parent directory, and upload() (recursive mkdir + write) lands the shard
  // outside the configured base. The provider must refuse it where the path is
  // built (vaultDir()). The safe-segment rule is a BFS-core invariant, so it
  // throws the core UnsafePathError — the same type the unpack-path traversal
  // guard (resolveSafeChildPath) raises — not a provider-specific ProviderError.
  // Scope is separators / '..' only; control chars / NUL are a transport concern
  // (covered in ftp.test.ts) and stay out of this filesystem-segment floor.
  //
  // Each case points the base path one level below a throwaway temp root, so the
  // escape resolves *inside* that root: the RED is a genuine escape (not an
  // incidental OS error) and nothing is left behind on disk.
  describe('vault name runtime guard', () => {
    async function withBase(run: (base: string) => Promise<void>): Promise<void> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-lf-trav-'));
      const base = path.join(root, 'base');
      await fs.mkdir(base);
      try {
        await run(base);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }

    // upload() recursively creates the resolved directory and writes the shard
    // there, so today the write SUCCEEDS at an escaping / separator-injected path
    // — exactly the vulnerability. The guard must reject before the write.
    const ESCAPING_NAMES: ReadonlyArray<[label: string, name: string]> = [
      ['bare dot-dot (escapes to parent)', '..'],
      ['parent-traversal prefix', '../evil'],
      ['forward-slash separator', 'a/b'],
      ['backslash separator', 'a\\b'],
    ];

    for (const [label, name] of ESCAPING_NAMES) {
      it(`should reject upload() for a vault name with ${label}`, async () => {
        await withBase(async (base) => {
          const { io } = createMockProviderIO();
          const p = new LocalFsProvider(makeConfig(base), io);
          p.setVaultName(name);

          await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.from('x'))).rejects.toThrow(UnsafePathError);
        });
      });
    }

    // Concrete read-escape demonstration: with '..', list() resolves base/.. =
    // the parent directory and returns its contents today. The guard must turn
    // that into UnsafePathError.
    it('should reject list() for a vault name that escapes to the parent dir', async () => {
      await withBase(async (base) => {
        const { io } = createMockProviderIO();
        const p = new LocalFsProvider(makeConfig(base), io);
        p.setVaultName('..');

        await expect(p.list()).rejects.toThrow(UnsafePathError);
      });
    });

    // Control case — proves the guard is not overly broad: a normal name still
    // works end-to-end (list returns, upload succeeds).
    it('should accept a normal vault name (no false positive)', async () => {
      await withBase(async (base) => {
        const { io } = createMockProviderIO();
        const p = new LocalFsProvider(makeConfig(base), io);
        p.setVaultName('my-backup');

        await expect(p.list()).resolves.toEqual([]);
        const ref = await uploadBuf(p, 'shard_0.bfs.1', Buffer.from('payload'));
        expect(ref.path).toBe('shard_0.bfs.1');
      });
    });
  });
});

// Header sidecar (BFSH): LocalFS keeps a relocated shard's updated header in a
// small `hdr_i.bfs.V` file next to the shard instead of rewriting the whole
// shard, so a `bfs repair` location change transfers KB, not the full payload.
// The sidecar name uses an `hdr_` prefix (not a `.hdr` suffix) so a version
// parser scanning `shard_*` never mistakes it for a shard.
describe('LocalFsProvider — header sidecar (BFSH)', () => {
  let tmpDir: string;
  let provider: LocalFsProvider;
  const shardRef = { provider_id: 'test-local', path: 'shard_0.bfs.1' };
  const sidecarPath = (): string => path.join(tmpDir, 'testvault', 'hdr_0.bfs.1');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-sidecar-'));
    const { io } = createMockProviderIO();
    provider = new LocalFsProvider(makeConfig(tmpDir), io);
    provider.setVaultName('testvault');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should report usesSidecar() === true', () => {
    expect(provider.usesSidecar()).toBe(true);
  });

  it('should round-trip header bytes through uploadHeaderSidecar/downloadHeaderSidecar', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    const sidecar = Buffer.from('BFSH-header-bytes');

    await provider.uploadHeaderSidecar(shardRef, sidecar);
    const read = await provider.downloadHeaderSidecar(shardRef, 16384);

    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, sidecar)).toBe(0);
  });

  it('should return null from downloadHeaderSidecar when no sidecar exists', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));

    await expect(provider.downloadHeaderSidecar(shardRef, 16384)).resolves.toBeNull();
  });

  it('should remove a stale sidecar when the shard is re-uploaded (reconcile)', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    await fs.writeFile(sidecarPath(), Buffer.from('stale-sidecar'));

    // A fresh shard carries a fresh in-shard header, so its old sidecar must go.
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload-v2'));

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  it('should remove the sidecar when the shard is deleted', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    await fs.writeFile(sidecarPath(), Buffer.from('sidecar'));

    await provider.delete(shardRef);

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  // A resumed prune (the shard is already gone) must still clear an orphan
  // `hdr_` sidecar. Because delete() no longer throws on an absent shard,
  // sidecar removal is reached and the stale header does not survive.
  it('should remove an orphan sidecar even when the shard is already absent', async () => {
    await fs.mkdir(path.join(tmpDir, 'testvault'), { recursive: true });
    await fs.writeFile(sidecarPath(), Buffer.from('orphan-sidecar'));

    await provider.delete(shardRef);

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });
});
