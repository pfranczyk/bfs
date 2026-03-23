import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { buildShard, parseShard } from '../../src/core/shard-io.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type {
  ProviderConfig,
  ShardHeader,
  ShardLocation,
} from '../../src/types/index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(basePath: string, id = 'test-local'): ProviderConfig {
  return { id, type: 'local', config: { path: basePath } };
}

const TEST_LOCATIONS: ShardLocation[] = [
  {
    shard_index: 0,
    provider_id: 'test-local',
    provider_type: 'local',
    connection_config: { path: '/tmp/test' },
    remote_path: '/tmp/test/vault/shard_0.bfs.1',
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
    map_length: 0,
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
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
    const ref = await provider.upload('shard_0.bfs.1', data);
    const downloaded = await provider.download(ref);
    expect(downloaded).toEqual(data);
  });

  it('should preserve binary data on upload/download', async () => {
    const data = Buffer.alloc(512);
    for (let i = 0; i < 512; i++) data[i] = i % 256;
    const ref = await provider.upload('shard_0.bfs.1', data);
    const downloaded = await provider.download(ref);
    expect(downloaded).toEqual(data);
  });

  it('should return hash in RemoteRef after upload', async () => {
    const data = Buffer.from('test');
    const ref = await provider.upload('shard_0.bfs.1', data);
    expect(ref.provider_id).toBe('test-local');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64); // SHA-256 hex
  });

  // ─── list ─────────────────────────────────────────────────────────────────

  it('should list uploaded files', async () => {
    await provider.upload('shard_0.bfs.1', Buffer.from('a'));
    await provider.upload('shard_1.bfs.1', Buffer.from('b'));
    const refs = await provider.list();
    const names = refs.map((r) => r.path).sort();
    expect(names).toEqual(['shard_0.bfs.1', 'shard_1.bfs.1']);
  });

  it('should filter list by prefix', async () => {
    await provider.upload('shard_0.bfs.1', Buffer.from('a'));
    await provider.upload('shard_0.bfs.2', Buffer.from('b'));
    await provider.upload('shard_1.bfs.1', Buffer.from('c'));
    const refs = await provider.list('shard_0');
    expect(refs.map((r) => r.path).sort()).toEqual([
      'shard_0.bfs.1',
      'shard_0.bfs.2',
    ]);
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
    const ref = await provider.upload('shard_0.bfs.1', Buffer.from('data'));
    await provider.delete(ref);
    const refs = await provider.list();
    expect(refs.map((r) => r.path)).not.toContain('shard_0.bfs.1');
  });

  it('should throw ProviderError when deleting non-existent file', async () => {
    await expect(
      provider.delete({ provider_id: 'test-local', path: 'nonexistent.bfs.1' }),
    ).rejects.toThrow(ProviderError);
  });

  // ─── healthCheck ──────────────────────────────────────────────────────────

  it('should return true for an existing path', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false for a non-existent path', async () => {
    const { io } = createMockProviderIO();
    const badProvider = new LocalFsProvider(
      makeConfig('/nonexistent/path/xyz'),
      io,
    );
    expect(await badProvider.healthCheck()).toBe(false);
  });

  // ─── authenticate ─────────────────────────────────────────────────────────

  it('should succeed silently when path already exists', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should create directory when confirm=true and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'new-subdir');
    const { io } = createMockProviderIO({
      [`Path "${newPath}" does not exist. Create it?`]: 'true',
    });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await p.authenticate();
    const stat = await fs.stat(newPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should throw when confirm=false and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'refused-dir');
    const { io } = createMockProviderIO({
      [`Path "${newPath}" does not exist. Create it?`]: 'false',
    });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await expect(p.authenticate()).rejects.toThrow(ProviderError);
  });

  // ─── rename ───────────────────────────────────────────────────────────────

  it('should rename a file and make it available under the new name', async () => {
    const ref = await provider.upload(
      'shard_0.bfs.1.tmp',
      Buffer.from('payload'),
    );
    const newRef = await provider.rename(ref, 'shard_0.bfs.1');
    expect(newRef.path).toBe('shard_0.bfs.1');

    const downloaded = await provider.download(newRef);
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

    const ref = await provider.upload('shard_0.bfs.1', originalShard);

    // Build a new header with updated location info (simulating a heal operation)
    const updatedHeader = makeHeader({
      shard_index: 0,
      location_map: [
        {
          ...TEST_LOCATIONS[0],
          remote_path: '/new/path/shard_0.bfs.1',
          shard_hash: 'c'.repeat(64),
        },
      ],
    });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    // Extract just the header bytes (everything before the payload+checksum)
    // We built a shard with empty payload so: [header][0 payload][32 checksum]
    // → header = newShardForHeader.subarray(0, length - 32)
    const newHeaderData = newShardForHeader.subarray(
      0,
      newShardForHeader.length - 32,
    );

    await provider.updateShardHeader(ref, newHeaderData);

    const updated = await provider.download(ref);

    // Should parse without error (checksum must be valid)
    const { header: h, payload: p } = parseShard(updated);

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
});
