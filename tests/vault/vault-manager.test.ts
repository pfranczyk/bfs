import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BFSIGNORE_CONTENT } from '../../src/core/ignore-defaults.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listManifests, readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { readState } from '../../src/vault/state.js';
import {
  init,
  listVersions,
  prune,
  pull,
  push,
  removeProvider,
} from '../../src/vault/vault-manager.js';
import { verifyAll } from '../../src/vault/verify.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-vault-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', config: { path: dir } };
}

function mockIO(answers: Record<string, string> = {}): ProviderIO {
  return createMockProviderIO(answers).io;
}

async function createTestFiles(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'hello.txt'), 'Hello, World!', 'utf-8');
  await fs.mkdir(path.join(dir, 'subdir'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'subdir', 'nested.txt'),
    'Nested content',
    'utf-8',
  );
}

async function listUserFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function scan(d: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.bfs' || e.name === '.bfsignore') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await scan(path.join(d, e.name), rel);
      else results.push(rel);
    }
  }
  await scan(dir, '');
  return results.sort();
}

// ─── init ─────────────────────────────────────────────────────────────────────

describe('init', () => {
  let root: string;
  let dirs: string[];

  beforeEach(async () => {
    root = await tmp();
    dirs = [await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...dirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should create .bfs/ and .bfs/manifests/', async () => {
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await expect(fs.access(path.join(root, '.bfs'))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, '.bfs', 'manifests')),
    ).resolves.toBeUndefined();
  });

  it('should write config.json with correct vault_name and scheme', async () => {
    await init(root, {
      vault_name: 'my-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const config = await readConfig(root);
    expect(config?.vault_name).toBe('my-vault');
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
    expect(config?.vault_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('should throw when providers.length !== N+K', async () => {
    await expect(
      init(root, {
        vault_name: 'v',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: {
          enabled: false,
          algorithm: 'aes-256-gcm',
          kdf: 'argon2id',
        },
        providers: [
          localProvider('p0', dirs[0] ?? ''),
          localProvider('p1', dirs[1] ?? ''),
        ], // 2, needs 3
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      }),
    ).rejects.toThrow();
  });

  it('should NOT write config.json when provider type is unknown', async () => {
    const badProvider: ProviderConfig = {
      id: 'bad',
      type: 'unknown-type',
      config: {},
    };
    await expect(
      init(root, {
        vault_name: 'v',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: {
          enabled: false,
          algorithm: 'aes-256-gcm',
          kdf: 'argon2id',
        },
        providers: [badProvider, badProvider, badProvider],
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      }),
    ).rejects.toThrow(/Unknown provider type/);

    // Config must NOT have been written — the fix ensures validation precedes writeConfig
    const config = await readConfig(root);
    expect(config).toBeNull();
  });

  it('should create .bfsignore with default content when file does not exist', async () => {
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const content = await fs.readFile(path.join(root, '.bfsignore'), 'utf-8');
    expect(content).toBe(DEFAULT_BFSIGNORE_CONTENT);
  });

  it('should NOT overwrite .bfsignore if it already exists', async () => {
    const bfsignorePath = path.join(root, '.bfsignore');
    await fs.writeFile(bfsignorePath, 'custom content', 'utf-8');
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const content = await fs.readFile(bfsignorePath, 'utf-8');
    expect(content).toBe('custom content');
  });
});

// ─── push ─────────────────────────────────────────────────────────────────────

describe('push', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should create manifest v001.json after first push', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    const m = await readManifest(root, 1);
    expect(m).not.toBeNull();
    expect(m?.version).toBe(1);
    expect(m?.health).toBe('healthy');
    expect(m?.file_count).toBeGreaterThanOrEqual(2); // hello.txt + subdir/nested.txt (+ .bfsignore if default was copied)
  });

  it('push × 2 → listVersions returns 2 manifests', async () => {
    await createTestFiles(root);
    const io = mockIO();
    await push(root, { io });
    await push(root, { io });
    const versions = await listVersions(root);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.version).toBe(1);
    expect(versions[1]?.version).toBe(2);
  });

  it('should update state.json after push', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    const state = await readState(root);
    expect(state.latest_version).toBe(1);
    expect(state.working_version).toBe(1);
  });

  it('should upload shard files to each provider', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    for (let i = 0; i < pdirs.length; i++) {
      const pdir = pdirs[i] ?? '';
      const files = await fs.readdir(path.join(pdir, 'vault'));
      expect(files).toContain(`shard_${i}.bfs.1`);
    }
  });

  it('push → prune → manifest deleted from disk', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    await prune(root, { versions: [1] });
    expect(await readManifest(root, 1)).toBeNull();
  });
});

// ─── pull (roundtrip) ─────────────────────────────────────────────────────────

describe('pull (roundtrip)', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should restore identical files after push → delete → pull', async () => {
    await createTestFiles(root);
    const before = await listUserFiles(root);
    await push(root, { io: mockIO() });

    // Simulate data loss
    await fs.rm(path.join(root, 'hello.txt'));
    await fs.rm(path.join(root, 'subdir'), { recursive: true });

    await pull(root, { io: mockIO(), force: true });

    const after = await listUserFiles(root);
    expect(after).toEqual(before);
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe(
      'Hello, World!',
    );
    expect(
      await fs.readFile(path.join(root, 'subdir', 'nested.txt'), 'utf-8'),
    ).toBe('Nested content');
  });

  it('should pull specific version (--version)', async () => {
    await createTestFiles(root);
    const io = mockIO();
    await push(root, { io }); // v1: hello.txt = "Hello, World!"
    await fs.writeFile(path.join(root, 'hello.txt'), 'Modified v2', 'utf-8');
    await push(root, { io }); // v2

    await pull(root, { version: 1, io, force: true });
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe(
      'Hello, World!',
    );
    const state = await readState(root);
    expect(state.working_version).toBe(1);
    expect(state.latest_version).toBe(2);
  });

  it('should pull into a new directory (copied .bfs/)', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    const root2 = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(root2, '.bfs'), {
        recursive: true,
      });
      await pull(root2, { io: mockIO(), force: true });
      expect(await fs.readFile(path.join(root2, 'hello.txt'), 'utf-8')).toBe(
        'Hello, World!',
      );
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });

  it('should tolerate 1 missing shard (K=1 RS repair)', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Delete one shard to simulate provider failure (shard_0)
    await fs.rm(path.join(pdirs[0] ?? '', 'vault', 'shard_0.bfs.1'));

    // Pull should succeed via RS repair
    await pull(root, { io: mockIO(), force: true });
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe(
      'Hello, World!',
    );
  });
});

// ─── removeProvider — strategy: remove ────────────────────────────────────────

describe('removeProvider — strategy: remove', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 4 providers, scheme 3/1
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should mark version as degraded and remove provider from config', async () => {
    await removeProvider(root, 'p0', { strategy: 'remove', io: mockIO() });
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).not.toContain('p0');
    expect(config?.providers).toHaveLength(3);
    const m = await readManifest(root, 1);
    expect(m?.health).toBe('degraded');
  });

  it('should throw validation error when removing from 3-provider vault (minimum 3)', async () => {
    // Set up a 3-provider vault
    const root3 = await tmp();
    const p3dirs = [await tmp(), await tmp(), await tmp()];
    try {
      await init(root3, {
        vault_name: 'vault',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: {
          enabled: false,
          algorithm: 'aes-256-gcm',
          kdf: 'argon2id',
        },
        providers: p3dirs.map((d, i) => localProvider(`pp${i}`, d)),
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      });
      await createTestFiles(root3);
      await push(root3, { io: mockIO() });
      await expect(
        removeProvider(root3, 'pp0', { strategy: 'remove', io: mockIO() }),
      ).rejects.toThrow();
    } finally {
      for (const d of [root3, ...p3dirs])
        await fs.rm(d, { recursive: true, force: true });
    }
  });
});

// ─── removeProvider — strategy: rebuild ───────────────────────────────────────

describe('removeProvider — strategy: rebuild', () => {
  let root: string;
  let pdirs: string[];
  let p4dir: string;

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // p0..p3, scheme 3/1
    p4dir = await tmp(); // spare provider for rebuild target
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs, p4dir])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild shard to new provider and verify healthy', async () => {
    // Add p4 as a spare target provider (simulating CLI "add new provider" step)
    const config = await readConfig(root);
    if (!config) throw new Error('Expected config to exist');
    config.providers.push(localProvider('p4', p4dir));
    await writeConfig(root, config);

    await removeProvider(root, 'p0', {
      strategy: 'rebuild',
      targetProviderId: 'p4',
      io: mockIO(),
    });

    // Config should have [p1, p2, p3, p4] (4 providers)
    const updatedConfig = await readConfig(root);
    const ids = updatedConfig?.providers.map((p) => p.id);
    expect(ids).not.toContain('p0');
    expect(ids).toContain('p4');
    expect(updatedConfig?.providers).toHaveLength(4);

    // Verify health
    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });
});

// ─── removeProvider — strategy: relocate ─────────────────────────────────────

describe('removeProvider — strategy: relocate', () => {
  let root: string;
  let pdirs: string[];
  let p0newDir: string;

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // scheme 3/1
    p0newDir = await tmp();
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Copy p0's vault files to the new location
    await fs.cp(pdirs[0] ?? '', p0newDir, { recursive: true });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs, p0newDir])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should update provider address and remain healthy', async () => {
    await removeProvider(root, 'p0', {
      strategy: 'relocate',
      newConnectionConfig: { path: p0newDir },
      io: mockIO(),
    });

    // Config should reflect new path
    const config = await readConfig(root);
    const p0 = config?.providers.find((p) => p.id === 'p0');
    expect(p0?.config.path).toBe(p0newDir);

    // Health should be preserved
    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });

  it('should throw when shards do not exist at the new provider address', async () => {
    // p0newDir is empty — no shard files were copied there
    // Spec: "Sprawdź czy shardy istnieją (list). Jeśli nie istnieją → błąd"
    const emptyDir = await tmp();
    try {
      await expect(
        removeProvider(root, 'p0', {
          strategy: 'relocate',
          newConnectionConfig: { path: emptyDir },
          io: mockIO(),
        }),
      ).rejects.toThrow();
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should fix invalid provider type via newType and remain healthy', async () => {
    // Corrupt p0 type in config to simulate a provider with unknown type
    const config = await readConfig(root);
    if (!config) throw new Error('no config');
    const corruptedProviders = config.providers.map((p) =>
      p.id === 'p0' ? { ...p, type: '?' } : p,
    );
    await writeConfig(root, { ...config, providers: corruptedProviders });

    // relocate with newType repairs both the path and the type
    await removeProvider(root, 'p0', {
      strategy: 'relocate',
      newConnectionConfig: { path: p0newDir },
      newType: 'local',
      io: mockIO(),
    });

    const updated = await readConfig(root);
    const p0 = updated?.providers.find((p) => p.id === 'p0');
    expect(p0?.type).toBe('local');
    expect(p0?.config.path).toBe(p0newDir);

    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });
});

// ─── scheme (per-version preservation) ───────────────────────────────────────

describe('scheme — manifests preserve original per-version scheme', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    // 4 providers → scheme 2/2 (N+K = 4) or 3/1
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('old manifest keeps its scheme after config scheme change and new push', async () => {
    // Push v1 with scheme 3/1 (4 providers: 3 data + 1 parity)
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Change scheme to 2/2 directly in config (same 4 providers, N+K unchanged)
    // Spec: "bfs scheme set zmienia jedynie config.json —
    //        istniejące wersje zachowują swój oryginalny schemat"
    const config = await readConfig(root);
    if (!config) throw new Error('no config');
    await writeConfig(root, {
      ...config,
      scheme: { data_shards: 2, parity_shards: 2 },
    });

    // Push v2 — new manifest uses new scheme
    await push(root, { io: mockIO() });

    const manifests = await listManifests(root);
    const v1 = manifests.find((m) => m.version === 1);
    const v2 = manifests.find((m) => m.version === 2);

    expect(v1?.scheme).toEqual({ data_shards: 3, parity_shards: 1 });
    expect(v2?.scheme).toEqual({ data_shards: 2, parity_shards: 2 });
  });
});

// ─── recovery ─────────────────────────────────────────────────────────────────

describe('recovery', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'test-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() }); // v1
    await push(root, { io: mockIO() }); // v2
    await push(root, { io: mockIO() }); // v3
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild 3 manifests after .bfs/ is deleted', async () => {
    // Simulate disaster: delete .bfs/
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    // Bootstrap from p0
    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(
      localProvider('p0', pdirs[0] ?? ''),
      bsIO,
    );
    await bootstrapProvider.authenticate();

    const report = await recover(root, {
      vaultName: 'test-vault',
      provider: bootstrapProvider,
      io: bsIO,
    });

    expect(report.manifests_rebuilt).toBe(3);
    const manifests = await listManifests(root);
    expect(manifests).toHaveLength(3);
    expect(manifests.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it('should rebuild config.json with correct vault_name', async () => {
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(
      localProvider('p0', pdirs[0] ?? ''),
      bsIO,
    );
    await bootstrapProvider.authenticate();

    await recover(root, {
      vaultName: 'test-vault',
      provider: bootstrapProvider,
      io: bsIO,
    });

    const config = await readConfig(root);
    expect(config?.vault_name).toBe('test-vault');
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
  });

  it('should rebuild manifests with rs_striped=true for v2 shards', async () => {
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(
      localProvider('p0', pdirs[0] ?? ''),
      bsIO,
    );
    await bootstrapProvider.authenticate();

    await recover(root, {
      vaultName: 'test-vault',
      provider: bootstrapProvider,
      io: bsIO,
    });

    const manifest = await readManifest(root, 1);
    expect(manifest?.rs_striped).toBe(true);
    expect(typeof manifest?.rs_stripe_size).toBe('number');
    expect(manifest?.rs_stripe_size).toBeGreaterThan(0);
    expect(manifest?.encrypted_per_shard).toBeUndefined();
  });
});
