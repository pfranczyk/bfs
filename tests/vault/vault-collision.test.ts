import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, VaultCollisionError } from '../../src/core/errors.js';
import { serializeShardHeader } from '../../src/core/shard-io.js';
import { createMockProviderIO, type ProviderFactory, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderHelp, RemoteRef, ShardHeader, StorageProvider, VerifyShardResult } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { assertNoForeignVault } from '../../src/vault/vault-collision.js';
import { init } from '../../src/vault/vault-manager.js';

// Regression guard for P1-C: `bfs init` (and provider add / push) must REFUSE a
// target location that already holds a DIFFERENT backup of the same name. Two
// machines running `bfs init documents` at the same base_path mint different
// vault_ids but identical shard paths, so the second machine's push silently
// overwrites the first's shards; the collision only surfaces later at read time.
// The write-path guard must catch a foreign vault_id BEFORE persisting config.
// This test fails until init calls the collision guard.

const FAKE_TYPE = 'fake-collision';
const FOREIGN_VAULT_ID = '11111111-1111-4111-8111-111111111111';

/** Serialized `--no-enc` V2 header carrying a FOREIGN vault_id (another backup). */
function foreignHeaderBytes(shardIndex: number): Buffer {
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: 2,
    vault_id: FOREIGN_VAULT_ID,
    vault_name: 'docs',
    blob_size: 128n,
    blob_hash: 'a'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: shardIndex,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: 64 * 1024,
    map_length: 0,
    location_map: [],
  };
  return serializeShardHeader(header);
}

/**
 * Minimal StorageProvider modelling a local medium that either already holds a
 * foreign backup's shard (config.foreign === true) or is empty. Only the methods
 * the init loop + collision guard touch carry behaviour; the rest are
 * unreachable so the test proves init never uploads/downloads payloads.
 */
class FakeCollisionProvider implements StorageProvider {
  readonly id: string;
  readonly type: string;
  private readonly foreign: boolean;
  private vaultName = '';

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.type = config.type;
    this.foreign = (config.config as { foreign?: unknown }).foreign === true;
  }

  async authenticate(): Promise<void> {}

  setVaultName(name: string): void {
    this.vaultName = name;
  }

  async probeConnection(): Promise<void> {
    if (this.vaultName === '') {
      throw new Error('setVaultName() must precede probeConnection()');
    }
  }

  async list(): Promise<RemoteRef[]> {
    return this.foreign ? [{ provider_id: this.id, path: 'shard_0.bfs.1' }] : [];
  }

  usesSidecar(): boolean {
    return false;
  }

  async downloadHeader(): Promise<Buffer> {
    return foreignHeaderBytes(0);
  }

  async downloadHeaderSidecar(): Promise<Nullable<Buffer>> {
    return null;
  }

  private unreachable(): never {
    throw new Error('FakeCollisionProvider: method not reachable in this scenario');
  }

  async upload(): Promise<RemoteRef> {
    return this.unreachable();
  }
  async download(): Promise<Readable> {
    return this.unreachable();
  }
  async delete(): Promise<void> {
    return this.unreachable();
  }
  async rename(): Promise<RemoteRef> {
    return this.unreachable();
  }
  async updateShardHeader(): Promise<RemoteRef> {
    return this.unreachable();
  }
  async getSize(): Promise<number> {
    return this.unreachable();
  }
  async listVaults(): Promise<string[]> {
    return this.unreachable();
  }
  async healthCheck(): Promise<boolean> {
    return this.unreachable();
  }
  async configureInteractive(): Promise<Record<string, unknown>> {
    return this.unreachable();
  }
  async configureFromFlags(): Promise<Record<string, unknown>> {
    return this.unreachable();
  }
  validateConfig(): string[] {
    return [];
  }
  describeConfig(): string {
    return this.unreachable();
  }
  getSecretFields(): readonly string[] {
    return [];
  }
  async uploadHeaderSidecar(): Promise<void> {
    return this.unreachable();
  }
  async verifyShard(): Promise<VerifyShardResult> {
    return this.unreachable();
  }
}

const fakeFactory: ProviderFactory = {
  lang: 'en',
  displayName: 'Fake (collision)',
  create(config: ProviderConfig): StorageProvider {
    return new FakeCollisionProvider(config);
  },
  help(): ProviderHelp {
    return { usage: '', description: '', flags: [], examples: [] };
  },
};

function providers(foreign: boolean): ProviderConfig[] {
  return [0, 1, 2].map((i) => ({ id: `p${i}`, type: FAKE_TYPE, adapterPackage: null, config: { path: `/m/p${i}`, foreign } }));
}

describe('init — foreign vault collision guard', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-collision-'));
    providerRegistry.register(FAKE_TYPE, fakeFactory);
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAKE_TYPE);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should abort init when the target location already holds a different backup (foreign vault_id)', async () => {
    const { io } = createMockProviderIO({}, root, false);

    await expect(
      init(root, { vault_name: 'docs', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers: providers(true), push_mode: PushMode.NewVersion, io }),
    ).rejects.toThrow(VaultCollisionError);

    // Config must NOT be written — the collision is caught before persist.
    expect(await readConfig(root)).toBeNull();
  });

  it('should let init proceed when every target location is empty (no false positive)', async () => {
    const { io } = createMockProviderIO({}, root, false);

    await expect(
      init(root, { vault_name: 'docs', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers: providers(false), push_mode: PushMode.NewVersion, io }),
    ).resolves.toBeUndefined();

    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });
});

const OUR_VAULT_ID = '22222222-2222-4222-8222-222222222222';

/** Serialized `--no-enc` V2 header carrying the given vault_id. */
function headerBytesFor(vaultId: string): Buffer {
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: 2,
    vault_id: vaultId,
    vault_name: 'docs',
    blob_size: 128n,
    blob_hash: 'a'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: 64 * 1024,
    map_length: 0,
    location_map: [],
  };
  return serializeShardHeader(header);
}

interface ProbeMock {
  /** Shard file paths list('shard_') returns. */
  refs?: string[];
  /** vault_id embedded in the served header. */
  headerVaultId?: string;
  /** When true, downloadHeader returns garbage so readShardHeader throws. */
  unreadable?: boolean;
  /** When true, list() throws (e.g. ENOTDIR when the vault path is a file). */
  listThrows?: boolean;
}

/** Minimal provider for direct assertNoForeignVault tests. */
function makeProbeProvider(id: string, opts: ProbeMock): StorageProvider {
  const unreachable = (): never => {
    throw new Error('makeProbeProvider: method not reachable');
  };
  return {
    id,
    type: 'mock',
    setVaultName: () => {},
    list: async () => {
      if (opts.listThrows === true) {
        // Mirrors LocalFsProvider.list() on a vault path that is a file: readdir
        // yields ENOTDIR, which is not ENOENT, so list() throws ProviderError.
        throw new ProviderError('Failed to list vault directory "/x": Error: ENOTDIR: not a directory');
      }
      return (opts.refs ?? []).map((p) => ({ provider_id: id, path: p }));
    },
    usesSidecar: () => false,
    downloadHeader: async () => (opts.unreadable === true ? Buffer.from('not-a-shard') : headerBytesFor(opts.headerVaultId ?? FOREIGN_VAULT_ID)),
    downloadHeaderSidecar: async () => null,
    authenticate: unreachable,
    probeConnection: unreachable,
    upload: unreachable,
    download: unreachable,
    delete: unreachable,
    rename: unreachable,
    updateShardHeader: unreachable,
    getSize: unreachable,
    listVaults: unreachable,
    healthCheck: unreachable,
    configureInteractive: unreachable,
    configureFromFlags: unreachable,
    validateConfig: () => [],
    describeConfig: unreachable,
    getSecretFields: () => [],
    uploadHeaderSidecar: unreachable,
    verifyShard: unreachable,
  } as unknown as StorageProvider;
}

describe('assertNoForeignVault', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-collision-h-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should pass when the location is empty', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: [] }), 'docs', OUR_VAULT_ID, io)).resolves.toBeUndefined();
  });

  it('should pass when the location holds our OWN backup (matching vault_id) — normal re-push', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_0.bfs.1'], headerVaultId: OUR_VAULT_ID }), 'docs', OUR_VAULT_ID, io)).resolves.toBeUndefined();
  });

  it('should throw when the location holds a DIFFERENT backup (foreign vault_id)', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_0.bfs.1'], headerVaultId: FOREIGN_VAULT_ID }), 'docs', OUR_VAULT_ID, io)).rejects.toThrow(VaultCollisionError);
  });

  it('should throw for a fresh init (expectedVaultId=null) when any shard is present', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_0.bfs.1'], headerVaultId: FOREIGN_VAULT_ID }), 'docs', null, io)).rejects.toThrow(VaultCollisionError);
  });

  it('should throw for a fresh init even when the shard header is unreadable', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_0.bfs.1'], unreadable: true }), 'docs', null, io)).rejects.toThrow(VaultCollisionError);
  });

  it('should pass on push/add when shards exist but no header is readable (owner may overwrite a damaged copy)', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_0.bfs.1'], unreadable: true }), 'docs', OUR_VAULT_ID, io)).resolves.toBeUndefined();
  });

  it('should ignore non-shard files (only parseable shard names count)', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { refs: ['shard_readme.txt', 'shard_notes'] }), 'docs', OUR_VAULT_ID, io)).resolves.toBeUndefined();
  });

  // Regression: a location whose listing FAILS (e.g. the vault path is a file →
  // readdir ENOTDIR on Linux) must not abort the caller. list() throwing is not
  // proof of a foreign vault, so the guard proceeds and the operation's own error
  // handling (a failing upload → degraded push) stays intact. Caught by smoke
  // Suite N (partial push) on Linux; latent on Windows where readdir does not
  // raise ENOTDIR the same way.
  it('should proceed (not throw) on push/add when list() fails — a non-listable location is not proof of a foreign vault', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { listThrows: true }), 'docs', OUR_VAULT_ID, io)).resolves.toBeUndefined();
  });

  it('should proceed (not throw) on a fresh init when list() fails', async () => {
    const { io } = createMockProviderIO({}, root, false);
    await expect(assertNoForeignVault(makeProbeProvider('p0', { listThrows: true }), 'docs', null, io)).resolves.toBeUndefined();
  });
});
