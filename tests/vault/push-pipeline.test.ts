import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PushDriftError } from '../../src/core/errors.js';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { CatalogDrift, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { _handleCatalogDrift } from '../../src/vault/push-pipeline.js';
import { recover } from '../../src/vault/recovery.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';
import { registerSecretProvider, SecretLocalProvider, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

// Hoisted mid-pack mutation target. When armed, the mocked fs.readFile below
// performs a real on-disk rewrite of `mutateFile` the moment `triggerFile` is
// read during packing — reproducing an external process changing a file inside
// the pack window, so snapshotAfter diverges from snapshotBefore (drift).
// Null = pure call-through, so every other test in this file sees the real fs.
const midPack = vi.hoisted(() => ({ target: null as { triggerFile: string; mutateFile: string; mutateContent: Buffer } | null }));

// Mock at the module boundary so the whole push pipeline shares one mocked
// module. Only readFile is overridden; default behaviour is a faithful
// call-through, and the rewrite fires solely for an armed target. Both the
// named and default exports are patched so `import fs from 'node:fs/promises'`
// and `import * as fs` observe the same override.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (p: unknown, options: unknown) => {
    const t = midPack.target;
    if (t && typeof p === 'string' && p === t.triggerFile) {
      await actual.writeFile(t.mutateFile, t.mutateContent); // real writeFile — bypasses the mock
    }
    return actual.readFile(p as never, options as never);
  }) as typeof actual.readFile;
  const patched = { ...actual, readFile };
  return { ...patched, default: patched };
});

beforeEach(() => {
  registerSecretProvider();
});

afterEach(() => {
  unregisterSecretProvider();
});

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-strip-'));
}

const secretProvider = secretProviderConfig;

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

describe('push location map secret stripping', () => {
  it('should strip the provider secret from the shard location map but keep it in config.json', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await push(root, { io: mockIO() });

    // The embedded location map (plaintext, vault is unencrypted) must NOT
    // carry the password, but must keep the non-secret coordinates.
    const shardBytes = await fs.readFile(path.join(dirs[0] ?? '', 'strip', 'shard_0.bfs.1'));
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBytes));
    payloadStream.on('error', () => {}).destroy();

    expect(header.location_map).toHaveLength(3);
    for (const loc of header.location_map) {
      expect(loc.connection_config.password).toBeUndefined();
      expect(loc.connection_config.path).toBeDefined();
      expect(loc.required_inputs).toEqual(['password']);
    }

    // config.json keeps the secret locally (protected by 0600 from K1).
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['pw-p0', 'pw-p1', 'pw-p2']);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push unencrypted warning', () => {
  it('should warn that the backup is not encrypted on every unencrypted push', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'plain',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const { io, logs } = createMockProviderIO();
    await push(root, { io });

    expect(logs.some((l) => l.level === 'warn' && /NOT encrypted/.test(l.message))).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('recovery with a stripped location map', () => {
  async function setupStrippedVault(root: string, dirs: string[], io: ProviderIO): Promise<void> {
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await push(root, { io });
    // Disaster: lose the local vault metadata. The remote shards carry a
    // stripped map, so recovery must obtain each provider's transport secret.
    await fs.rm(path.join(root, '.bfs'), { recursive: true });
  }

  it('should reuse the bootstrap secret for sibling providers without prompting', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No interactive answers: every provider must connect from the seeded pool.
    const { io } = createMockProviderIO();
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io, bootstrapInputs: { password: 'shared-key' } });

    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['shared-key', 'shared-key', 'shared-key']);
    expect(config?.providers.map((p) => p.config.path)).toEqual(dirs);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should prompt for a missing secret, pool it for the next provider, and degrade the unanswered one', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No seed; only p1 has an answer. p2 must reuse it from the pool (one
    // prompt), and p0 (no answer) degrades to an absent secret in config.json.
    const answers: Record<string, string> = { [fmt('recovery_ask_transport_password', 'password', 'p1')]: 'typed-key' };
    const { io } = createMockProviderIO(answers);
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io });

    const config = await readConfig(root);
    const passwordById = new Map(config?.providers.map((p) => [p.id, p.config.password]));
    expect(passwordById.get('p0')).toBeUndefined();
    expect(passwordById.get('p1')).toBe('typed-key');
    expect(passwordById.get('p2')).toBe('typed-key');

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push catalog drift verification', () => {
  /** Inline ProviderIO with a fixed confirm answer and a warn collector. */
  function driftIO(confirmAnswer: boolean, warns: string[]): ProviderIO {
    return {
      lang: 'en',
      workDir: process.cwd(),
      ask: async () => '',
      askSecret: async () => '',
      confirm: async () => confirmAnswer,
      choose: async () => '',
      info: () => {},
      debug: () => {},
      warn: (message: string) => {
        warns.push(message);
      },
      progress: () => {},
    };
  }

  const realDrift: CatalogDrift = { changed: ['data.bin'], vanished: [], appeared: [] };
  const noDrift: CatalogDrift = { changed: [], vanished: [], appeared: [] };

  describe('_handleCatalogDrift decision gate', () => {
    it('should resolve and emit no warning when there is no drift', async () => {
      const warns: string[] = [];

      await _handleCatalogDrift({ drift: noDrift, io: driftIO(true, warns) });

      expect(warns).toEqual([]);
    });

    it('should accept drift and warn when allowDrift is true', async () => {
      const warns: string[] = [];

      await _handleCatalogDrift({ drift: realDrift, allowDrift: true, io: driftIO(false, warns) });

      expect(warns.length).toBeGreaterThanOrEqual(1);
    });

    it('should resolve when interactive and the user confirms', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, interactive: true, io: driftIO(true, warns) })).resolves.toBeUndefined();
    });

    it('should reject with BfsError when interactive and the user declines', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, interactive: true, io: driftIO(false, warns) })).rejects.toThrow(BfsError);
    });

    it('should reject with PushDriftError when non-interactive and drift is not allowed', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, io: driftIO(false, warns) })).rejects.toThrow(PushDriftError);
    });
  });

  // End-to-end proof: a source file changes inside the pack window (mtime + size),
  // so snapshotAfter diverges from snapshotBefore. The mocked fs.readFile rewrites
  // `a-first.bin` the instant `z-last.bin` is read during packing — the earlier
  // file's blob bytes are already captured, matching a real mid-push mutation.
  describe('end-to-end mid-pack drift', () => {
    async function tmpDir(): Promise<string> {
      return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-drift-'));
    }

    async function initVault(root: string, dirs: string[]): Promise<void> {
      await init(root, {
        vault_name: 'drift',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: dirs.map((d, i) => secretProviderConfig(`p${i}`, d)),
        push_mode: PushMode.NewVersion,
        io: createMockProviderIO().io,
      });
    }

    afterEach(() => {
      midPack.target = null;
    });

    it('should reject a non-interactive push when a file drifts mid-pack', async () => {
      const root = await tmpDir();
      const dirs = [await tmpDir(), await tmpDir(), await tmpDir()];
      const firstAbs = path.join(root, 'a-first.bin');
      const lastAbs = path.join(root, 'z-last.bin');
      await fs.writeFile(firstAbs, Buffer.alloc(256, 0xaa));
      await fs.writeFile(lastAbs, Buffer.alloc(256, 0xbb));
      await initVault(root, dirs);

      // Grow a-first.bin (size + mtime change) while z-last.bin is being packed.
      midPack.target = { triggerFile: lastAbs, mutateFile: firstAbs, mutateContent: Buffer.alloc(512, 0xcc) };
      try {
        await expect(push(root, { io: createMockProviderIO().io })).rejects.toThrow(PushDriftError);
      } finally {
        midPack.target = null;
      }

      await fs.rm(root, { recursive: true, force: true });
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    });

    it('should accept mid-pack drift with allowDrift and restore the unchanged files', async () => {
      const root = await tmpDir();
      const dirs = [await tmpDir(), await tmpDir(), await tmpDir()];
      const firstAbs = path.join(root, 'a-first.bin');
      const lastAbs = path.join(root, 'z-last.bin');
      const lastContent = Buffer.alloc(256, 0xbb); // never mutated — must restore byte-for-byte
      await fs.writeFile(firstAbs, Buffer.alloc(256, 0xaa));
      await fs.writeFile(lastAbs, lastContent);
      await initVault(root, dirs);

      midPack.target = { triggerFile: lastAbs, mutateFile: firstAbs, mutateContent: Buffer.alloc(512, 0xcc) };
      let result: Awaited<ReturnType<typeof push>>;
      try {
        result = await push(root, { allowDrift: true, io: createMockProviderIO().io });
      } finally {
        midPack.target = null;
      }

      expect(result.health).toBe(VersionHealth.Healthy);

      // The accepted backup must still be recoverable: pull version 1 back and
      // confirm the file that did NOT drift comes back byte-for-byte.
      await pull(root, { version: result.version, force: true, io: createMockProviderIO().io });
      const restored = await fs.readFile(lastAbs);
      assert(restored.equals(lastContent), 'z-last.bin did not restore byte-for-byte');

      await fs.rm(root, { recursive: true, force: true });
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    });
  });
});
