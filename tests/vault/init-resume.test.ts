import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BfsError, ProviderError, VaultCollisionError } from '../../src/core/errors.js';
import { createMockProviderIO, type ProviderFactory, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderHelp, RemoteRef, StorageProvider, VaultConfig, VerifyShardResult } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { readState, writeState } from '../../src/vault/state.js';
import { type InitOptions, init, prune, pull, push } from '../../src/vault/vault-manager.js';

// `init` is resumable. Every storage that passes its probe is written to
// .bfs/config.json at once - the first write follows the first successful probe,
// each later one rewrites the file - so an init cut short in the middle (Ctrl+C,
// a closed terminal, a storage that does not answer) keeps what the operator
// already set up. A second `init` in that directory picks up from the file: the
// settings come from it, storages already recorded are taken as verified (the
// run that recorded them probed them), and only the missing ones are probed and
// appended. What may be resumed is decided by the directory's state:
//   - no .bfs/, or .bfs/ without config.json and without manifest files -> new;
//   - a readable config.json short of N+K storages and with no version -> resume;
//   - a readable config.json with every storage -> refusal, nothing to finish;
//   - an unreadable config.json, or .bfs/ without config.json but with manifest
//     files -> refusal that names the state and offers no command.
// A resume that would change what is recorded - another backup name, another
// scheme, other settings under a recorded storage name - is refused: silently
// ignoring the command line would leave a configuration other than the one
// asked for, and silently overwriting would make `init` an undocumented
// `provider edit`.

const FAKE_TYPE = 'fake-init-resume';

/** Ids whose probe fails on the next call (a storage that does not answer). */
let failingIds: Set<string>;
/** probeConnection() calls per provider id. */
let probeCalls: Map<string, number>;
/** Runs at the start of every probe - lets a test look at the disk mid-init. */
let onProbe: Nullable<(id: string) => Promise<void>>;
/** Ids whose medium already holds a part of another backup of the same name. */
let foreignIds: Set<string>;

/**
 * Minimal StorageProvider for the init path: an empty medium whose probe passes
 * unless its id is in `failingIds`. Everything init does not touch is
 * unreachable.
 */
class FakeProvider implements StorageProvider {
  readonly id: string;
  readonly type: string;
  private vaultName = '';

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.type = config.type;
  }

  async authenticate(): Promise<void> {}

  setVaultName(name: string): void {
    this.vaultName = name;
  }

  async probeConnection(): Promise<void> {
    probeCalls.set(this.id, (probeCalls.get(this.id) ?? 0) + 1);
    if (onProbe !== null) await onProbe(this.id);
    if (this.vaultName === '') throw new Error('setVaultName() must precede probeConnection()');
    if (failingIds.has(this.id)) throw new ProviderError(`storage ${this.id} does not answer`);
  }

  async list(): Promise<RemoteRef[]> {
    // A storage in `foreignIds` already holds a part of another backup under the
    // same name.
    return foreignIds.has(this.id) ? [{ provider_id: this.id, path: 'shard_0.bfs.1' }] : [];
  }

  usesSidecar(): boolean {
    return false;
  }

  private unreachable(): never {
    throw new Error('FakeProvider: method not reachable in this scenario');
  }

  async downloadHeader(): Promise<Buffer> {
    return this.unreachable();
  }
  async downloadHeaderSidecar(): Promise<Nullable<Buffer>> {
    return this.unreachable();
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
    return ['password'];
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
  displayName: 'Fake (resume)',
  create(config: ProviderConfig): StorageProvider {
    return new FakeProvider(config);
  },
  help(): ProviderHelp {
    return { usage: '', description: '', flags: [], examples: [] };
  },
};

/** The storage the fixture names `p<i>`, at its own path. */
function storage(i: number, pathOverride?: string): ProviderConfig {
  return { id: `p${i}`, type: FAKE_TYPE, adapterPackage: null, config: { path: pathOverride ?? `/m/p${i}` } };
}

/** Init options for a 2/1 backup named `name` over `providers`, encrypted, uncompressed. */
function options(root: string, name: string, providers: ProviderConfig[], scheme = { data_shards: 2, parity_shards: 1 }): InitOptions {
  const { io } = createMockProviderIO({}, root, false);
  return { vault_name: name, scheme, encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, compression: { enabled: false, algorithm: 'deflate' }, providers, push_mode: PushMode.NewVersion, io };
}

/** A configuration init wrote before it was cut short: one storage of a 2/1 scheme. */
function unfinishedConfig(): VaultConfig {
  return {
    vault_id: '550e8400-e29b-41d4-a716-446655440000',
    vault_name: 'docs',
    version: 1,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers: [storage(0)],
    max_ram_mb: null,
  };
}

/** Runs an init whose second storage does not answer, leaving a partial configuration. */
async function interruptedInit(root: string): Promise<void> {
  failingIds = new Set(['p1']);
  await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(ProviderError);
  failingIds = new Set();
}

describe('init - resumable after an interruption', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-resume-'));
    failingIds = new Set();
    probeCalls = new Map();
    onProbe = null;
    foreignIds = new Set();
    providerRegistry.register(FAKE_TYPE, fakeFactory);
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAKE_TYPE);
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('recording storages as they pass', () => {
    it('should write config.json with the storage that passed before the one that failed, settings included', async () => {
      await interruptedInit(root);

      const config = await readConfig(root);
      expect(config?.vault_name).toBe('docs');
      expect(config?.vault_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
      expect(config?.encryption.enabled).toBe(true);
      expect(config?.compression.enabled).toBe(false);
      expect(config?.providers.map((p) => p.id)).toEqual(['p0']);
    });

    // The write happens when the storage passes, not on the way out of a failure:
    // a closed terminal or a killed process runs no handler, so a write placed in
    // a catch would leave nothing behind. The disk is read while the next storage
    // is being probed, in a run that does not fail at all.
    it('should have each storage on disk before the next one is probed', async () => {
      const seen = new Map<string, string[]>();
      onProbe = async (id) => {
        seen.set(id, (await readConfig(root))?.providers.map((p) => p.id) ?? []);
      };

      await init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]));

      expect(seen.get('p0')).toEqual([]);
      expect(seen.get('p1')).toEqual(['p0']);
      expect(seen.get('p2')).toEqual(['p0', 'p1']);
    });

    // Every later probe rewrites the file - not only the first one - so an init
    // cut short at its third storage keeps two.
    it('should rewrite config.json after each later storage that passes', async () => {
      failingIds = new Set(['p2']);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2), storage(3)], { data_shards: 3, parity_shards: 1 }))).rejects.toThrow(ProviderError);

      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0', 'p1']);
    });

    // Passing the probe is not enough to be recorded: a storage that already
    // holds another backup of the same name is refused before it reaches the
    // file - on any position, not only the first.
    it('should not record a later storage that holds another backup of the same name', async () => {
      foreignIds = new Set(['p1']);

      const pending = init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]));
      await expect(pending).rejects.toThrow(VaultCollisionError);
      const message = await refusal(pending);

      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0']);
      // With a configuration already written here, `bfs recovery` would refuse
      // this directory and another backup name would refuse the resume - so the
      // refusal names the collision and nothing else.
      expect(message).toContain('p1');
      expect(message).not.toContain('bfs recovery');
      expect(message).not.toMatch(/different backup name/i);
    });

    it('should write nothing when not a single storage passed', async () => {
      failingIds = new Set(['p0']);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(ProviderError);

      expect(await readConfig(root)).toBeNull();
    });
  });

  describe('resuming', () => {
    it('should probe only the storages not yet recorded and finish the configuration', async () => {
      await interruptedInit(root);
      const first = await readConfig(root);
      const p0ProbesBefore = probeCalls.get('p0');
      expect(p0ProbesBefore).toBe(1);

      await init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]));

      const config = await readConfig(root);
      expect(config?.providers.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
      expect(config?.vault_id).toBe(first?.vault_id);
      expect(probeCalls.get('p0')).toBe(p0ProbesBefore);
      expect(probeCalls.get('p2')).toBe(1);
      // readState() falls back to version 0 for a missing file, so the file itself
      // is checked first: the finished init must have written it.
      await expect(fs.stat(path.join(root, '.bfs', 'state.json'))).resolves.toBeDefined();
      expect((await readState(root)).latest_version).toBe(0);
    });

    // A collision on the first storage a RESUME adds: the configuration is already
    // here, so neither `bfs recovery` nor another backup name could be carried
    // out - the refusal names the collision and nothing else.
    it('should refuse a storage holding another backup during a resume, without the advice a fresh init carries', async () => {
      await interruptedInit(root);
      foreignIds = new Set(['p1']);

      const message = await refusal(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)])));

      expect(message).toContain('p1');
      expect(message).not.toContain('bfs recovery');
      expect(message).not.toMatch(/different backup name/i);
      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0']);
    });

    // A resume cut short again keeps what it added: the storages recorded so far
    // accumulate across runs.
    it('should keep the storages a resume added when the resume is cut short too', async () => {
      await interruptedInit(root);
      failingIds = new Set(['p2']);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(ProviderError);

      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0', 'p1']);
    });

    // A finished backup is not resumable: the same command a second time is the
    // refusal it always was.
    it('should refuse once every storage is recorded', async () => {
      await interruptedInit(root);
      await init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]));
      const probes = [...probeCalls.values()].reduce((a, b) => a + b, 0);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(/docs/);

      expect([...probeCalls.values()].reduce((a, b) => a + b, 0)).toBe(probes);
    });

    it('should refuse a resume under another backup name and keep the recorded one', async () => {
      await interruptedInit(root);

      const message = await init(root, options(root, 'photos', [storage(0), storage(1), storage(2)])).then(
        () => '',
        (e: unknown) => (e instanceof BfsError ? e.message : `not a BfsError: ${String(e)}`),
      );

      // Both names: the operator has to see which one is recorded and which one was asked for.
      expect(message).toContain('docs');
      expect(message).toContain('photos');
      const config = await readConfig(root);
      expect(config?.vault_name).toBe('docs');
      expect(config?.providers.map((p) => p.id)).toEqual(['p0']);
      expect(probeCalls.get('p2')).toBeUndefined();
    });

    it('should refuse a resume with another scheme', async () => {
      await interruptedInit(root);

      const probes = [...probeCalls.values()].reduce((a, b) => a + b, 0);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2), storage(3)], { data_shards: 3, parity_shards: 1 }))).rejects.toThrow(BfsError);

      expect((await readConfig(root))?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
      expect([...probeCalls.values()].reduce((a, b) => a + b, 0)).toBe(probes);
    });

    it('should name both schemes when refusing a resume with another scheme', async () => {
      await interruptedInit(root);

      const message = await refusal(init(root, options(root, 'docs', [storage(0), storage(1), storage(2), storage(3), storage(4)], { data_shards: 3, parity_shards: 2 })));

      expect(message).toMatch(/\b2\b.*\b1\b/s);
      expect(message).toMatch(/\b3\b.*\b2\b/s);
    });

    // The refusal names the storage whose settings differ - never the secret
    // values themselves, which would land in a terminal and its scrollback.
    it('should not show the secrets of a recorded storage when its settings differ', async () => {
      // Encryption matches the options below, so the only difference is p0's settings.
      await writeConfig(root, { ...unfinishedConfig(), encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers: [{ ...storage(0), config: { path: '/m/p0', password: 'recorded-secret' } }] });

      const message = await refusal(init(root, options(root, 'docs', [{ ...storage(0), config: { path: '/m/p0', password: 'typed-secret' } }, storage(1), storage(2)])));

      expect(message).toMatch(/\bp0\b/);
      expect(message).not.toContain('recorded-secret');
      expect(message).not.toContain('typed-secret');
    });

    // The same storage name with other settings (another path, another password)
    // would either be ignored - a configuration other than the one asked for -
    // or overwrite the recorded one, making init a provider edit without its
    // guarantees.
    it('should refuse a resume that gives a recorded storage other settings', async () => {
      await interruptedInit(root);

      await expect(init(root, options(root, 'docs', [storage(0, '/elsewhere'), storage(1), storage(2)]))).rejects.toThrow(/p0/);

      expect((await readConfig(root))?.providers[0]?.config).toEqual({ path: '/m/p0' });
      expect(probeCalls.get('p1')).toBe(1);
    });

    // Short of storages with versions recorded is not an interrupted init: it is
    // a backup whose pool went short (provider remove --strategy remove), where
    // the operator matches the pool or the scheme.
    it('should refuse to resume a configuration short of storages once a version exists', async () => {
      await interruptedInit(root);
      await writeState(root, { latest_version: 1, working_version: 1 });
      const probes = [...probeCalls.values()].reduce((a, b) => a + b, 0);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(/docs/);

      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0']);
      expect([...probeCalls.values()].reduce((a, b) => a + b, 0)).toBe(probes);
    });

    it('should refuse to resume a configuration short of storages when a manifest file exists', async () => {
      await interruptedInit(root);
      await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v001.json'), '{}', 'utf-8');
      const probes = [...probeCalls.values()].reduce((a, b) => a + b, 0);

      await expect(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]))).rejects.toThrow(/docs/);

      expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p0']);
      expect([...probeCalls.values()].reduce((a, b) => a + b, 0)).toBe(probes);
    });
  });

  describe('directories that cannot be resumed', () => {
    // `.bfs/manifests` alone is created by every interrupted init, so its
    // presence says nothing. Manifest FILES are versions of a backup whose
    // settings are gone. The refusal says that and no more: whether the operator
    // wants that backup back or a new one here is not something BFS can tell.
    it('should refuse .bfs/ without config.json but with manifest files, naming the state without a command', async () => {
      await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
      await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v001.json'), '{}', 'utf-8');

      const message = await refusal(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)])));

      expect(message).toMatch(/version/i);
      expect(message).not.toMatch(/`bfs [a-z]/);
      expect(probeCalls.size).toBe(0);
      expect(await readConfig(root)).toBeNull();
    });

    // Without manifest files nothing says versions exist - so the refusal for an
    // unreadable configuration must not claim they do, and offers no command.
    it('should refuse an unreadable configuration with no versions beside it, without claiming any', async () => {
      await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
      await fs.writeFile(path.join(root, '.bfs', 'config.json'), '{"vault_id": "trunc', 'utf-8');

      const message = await refusal(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)])));

      expect(message).toContain('config.json');
      expect(message).not.toMatch(/version/i);
      expect(message).not.toMatch(/`bfs [a-z]/);
      expect(message).not.toMatch(/delete|remove/i);
      expect(probeCalls.size).toBe(0);
    });

    it('should start a new backup in .bfs/ without config.json and without manifest files', async () => {
      await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });

      await init(root, options(root, 'docs', [storage(0), storage(1), storage(2)]));

      expect((await readConfig(root))?.providers).toHaveLength(3);
    });

    // An unreadable configuration with manifest files beside it: the refusal
    // names what cannot be read and that versions are there, and suggests no way
    // out - deleting config.json alone would lead straight to the refusal for
    // manifests without a configuration.
    it('should refuse an unreadable configuration beside versions, naming the state without a command', async () => {
      await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
      await fs.writeFile(path.join(root, '.bfs', 'config.json'), '{"vault_id": "trunc', 'utf-8');
      await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v001.json'), '{}', 'utf-8');

      const message = await refusal(init(root, options(root, 'docs', [storage(0), storage(1), storage(2)])));

      expect(message).toContain('config.json');
      expect(message).toMatch(/version/i);
      expect(message).not.toMatch(/`bfs [a-z]/);
      expect(message).not.toMatch(/delete|remove/i);
      expect(probeCalls.size).toBe(0);
    });
  });

  describe('other commands on an unfinished configuration', () => {
    // The pool is short and no version exists: the refusal says the backup has
    // none yet, beside the counts. That is the state; what to do about it - finish
    // init, add a storage, start over - is the operator's call, so no new command
    // is offered. The configuration is written directly so the refusal under test
    // is the short pool, not the missing file.
    it('should say a backup with a short pool has no version yet, without naming bfs init', async () => {
      await writeConfig(root, unfinishedConfig());
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(push(root, { io }));

      expect(message).toMatch(/no version/i);
      expect(message).toMatch(/\b3\b/);
      expect(message).not.toContain('No backup configuration found');
      expect(message).not.toContain('bfs init');
    });

    // A pool at or above the minimum of three, still short of N+K, takes the other
    // branch of the scheme check - which must name the same state.
    it('should say so as well for a pool short of N+K but not below the minimum', async () => {
      await writeConfig(root, { ...unfinishedConfig(), scheme: { data_shards: 3, parity_shards: 1 }, providers: [storage(0), storage(1), storage(2)] });
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(push(root, { io }));

      expect(message).toMatch(/no version/i);
      expect(message).toMatch(/\b4\b/);
      expect(message).not.toContain('bfs init');
    });

    // pull and prune check the scheme on their own, so each names the state.
    it('should say so when pull meets a configuration that init did not finish', async () => {
      await writeConfig(root, unfinishedConfig());
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(pull(root, { io, force: true, yes: true }));

      expect(message).toMatch(/no version/i);
      expect(message).not.toContain('bfs init');
    });

    it('should say so when prune meets a configuration that init did not finish', async () => {
      await writeConfig(root, unfinishedConfig());
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(prune(root, { versions: [1], io }));

      expect(message).toMatch(/no version/i);
      expect(message).not.toContain('bfs init');
    });

    // A pool short of storages with a version recorded is the state after
    // provider remove --strategy remove: the backup HAS versions, so saying it has
    // none would be false.
    it('should not say a short pool has no version once a version exists', async () => {
      await writeConfig(root, unfinishedConfig());
      await writeState(root, { latest_version: 1, working_version: 1 });
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(push(root, { io }));

      expect(message).toMatch(/\b3\b/);
      expect(message).not.toMatch(/no version/i);
    });

    // "No version" is one test for init and the other commands: a manifest file
    // counts even at latest_version 0 (a backup written as version 0 exists).
    it('should not say a short pool has no version when a manifest file exists at version 0', async () => {
      await writeConfig(root, unfinishedConfig());
      await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
      await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v000.json'), '{}', 'utf-8');
      const { io } = createMockProviderIO({}, root, false);

      const message = await refusal(push(root, { io }));

      expect(message).toMatch(/\b3\b/);
      expect(message).not.toMatch(/no version/i);
    });
  });
});

/** The message of the error `pending` rejects with, or '' when it resolves. */
async function refusal(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => '',
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );
}
