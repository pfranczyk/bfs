import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { createMockProviderIO, type ProviderFactory, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderHelp, RemoteRef, StorageProvider, VerifyShardResult } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init } from '../../src/vault/vault-manager.js';

// A working directory that already describes a backup must not be re-initialized
// out from under the operator. `init` rewrites config.json with a fresh vault_id
// and resets state.json to version 0, while the shards on the media keep the old
// vault_id - so the directory stops reaching data it holds versions for. The
// medium-side guard (assertNoForeignVault) does not cover this: it inspects the
// sub-directory named after the NEW backup name, which is empty whenever the
// operator supplies a different one.

const FAKE_TYPE = 'fake-init-existing';

/** Counts probeConnection() calls, so a refusal can be shown to precede any contact with the media. */
let probeCalls = 0;

/**
 * Minimal StorageProvider for the init path: an empty medium that accepts the
 * connectivity probe. Everything init does not touch is unreachable, so the test
 * proves the refusal never reaches for a payload.
 */
class FakeEmptyProvider implements StorageProvider {
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
    probeCalls += 1;
    if (this.vaultName === '') {
      throw new Error('setVaultName() must precede probeConnection()');
    }
  }

  async list(): Promise<RemoteRef[]> {
    return [];
  }

  usesSidecar(): boolean {
    return false;
  }

  private unreachable(): never {
    throw new Error('FakeEmptyProvider: method not reachable in this scenario');
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
  displayName: 'Fake (empty)',
  create(config: ProviderConfig): StorageProvider {
    return new FakeEmptyProvider(config);
  },
  help(): ProviderHelp {
    return { usage: '', description: '', flags: [], examples: [] };
  },
};

function providers(): ProviderConfig[] {
  return [0, 1, 2].map((i) => ({ id: `p${i}`, type: FAKE_TYPE, adapterPackage: null, config: { path: `/m/p${i}` } }));
}

/** Runs `init` under a mock IO, with the fixture's scheme and no encryption. */
async function runInit(root: string, vaultName: string): Promise<void> {
  const { io } = createMockProviderIO({}, root, false);
  await init(root, { vault_name: vaultName, scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers: providers(), push_mode: PushMode.NewVersion, io });
}

describe('init - a directory that already holds a backup', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-existing-'));
    probeCalls = 0;
    providerRegistry.register(FAKE_TYPE, fakeFactory);
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAKE_TYPE);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should refuse a second init and leave the existing backup identity intact', async () => {
    await runInit(root, 'docs');
    const before = await readConfig(root);
    expect(before?.vault_id).toBeTruthy();

    // A different name is what slips past the medium-side guard, so that is the
    // input this pins. The refusal has to name the backup standing in the way -
    // a bare BfsError would also be satisfied by an unrelated refusal (a scheme
    // mismatch, a collision on the media), which is not what this pins.
    await expect(runInit(root, 'photos')).rejects.toThrow(/docs/);

    const after = await readConfig(root);
    expect(after?.vault_id).toBe(before?.vault_id);
    expect(after?.vault_name).toBe('docs');
  });

  it('should not reset the version history recorded for the existing backup', async () => {
    await runInit(root, 'docs');
    // Stand in for a backup that has been pushed: versions exist on the media.
    const state = await readState(root);
    await writeState(root, { ...state, latest_version: 3, working_version: 3 });

    await expect(runInit(root, 'photos')).rejects.toThrow(BfsError);

    const after = await readState(root);
    expect(after.latest_version).toBe(3);
    expect(after.working_version).toBe(3);
  });

  it('should refuse before contacting any medium', async () => {
    await runInit(root, 'docs');
    // Anchored, not just compared: an equality between two counts would hold
    // just as well if probing stopped happening at all, and would then guard
    // nothing. One probe per medium is what a successful init performs.
    const probesAfterFirstInit = probeCalls;
    expect(probesAfterFirstInit).toBe(3);

    await expect(runInit(root, 'photos')).rejects.toThrow(BfsError);

    // Probing creates the target directory and round-trips a probe file, so a
    // refusal that ran the loop first would leave the new name's sub-directory
    // behind on every medium.
    expect(probeCalls).toBe(probesAfterFirstInit);
  });

  it('should still initialize a directory that holds no backup', async () => {
    await expect(runInit(root, 'docs')).resolves.toBeUndefined();

    const config = await readConfig(root);
    expect(config?.vault_name).toBe('docs');
  });

  it('should still initialize after an init that failed before writing a configuration', async () => {
    // `.bfs/manifests` and `.bfsignore` are created before the media loop runs
    // and the configuration is written after it, so every way that loop can fail
    // - an unknown adapter, a refused probe, a foreign backup at the target -
    // leaves the directory populated but without a config.json. Keying the
    // refusal on `.bfs/` rather than on the configuration would lock that
    // operator out for good: no command removes `.bfs/`, so a dead port would
    // cost them the directory. This drives the failure through the unknown
    // adapter, the cheapest of those routes to the same state.
    const { io } = createMockProviderIO({}, root, false);
    const unknown: ProviderConfig = { id: 'bad', type: 'no-such-adapter', adapterPackage: null, config: {} };
    await expect(
      init(root, { vault_name: 'docs', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers: [unknown, unknown, unknown], push_mode: PushMode.NewVersion, io }),
    ).rejects.toThrow();
    expect(await readConfig(root)).toBeNull();
    await fs.access(path.join(root, '.bfs', 'manifests'));

    await expect(runInit(root, 'docs')).resolves.toBeUndefined();
    expect((await readConfig(root))?.vault_name).toBe('docs');
  });

  it('should refuse a configuration whose contents parse to nothing usable', async () => {
    await runInit(root, 'docs');
    // `readConfig` answers `null` for a file whose whole content is `null`, the
    // same answer it gives for a file that is not there - so a guard reading the
    // parsed value cannot tell "no backup here" from "a backup whose record went
    // bad", and would overwrite the second. Keying on the file itself separates
    // them. The name is unavailable in this state, so the refusal must not offer
    // a hole where it would have been.
    await fs.writeFile(path.join(root, '.bfs', 'config.json'), 'null', 'utf-8');

    await expect(runInit(root, 'photos')).rejects.toThrow(BfsError);
    await expect(runInit(root, 'photos')).rejects.not.toThrow(/undefined|null/);
  });

  it('should not call a configuration damaged when the read itself failed', async () => {
    await runInit(root, 'docs');
    // A read that fails for a reason other than "not there" - a lock a parallel
    // run holds, a permission wall, a directory in place of the file - says
    // nothing about whether the file is intact. Concluding "damaged" would lead
    // to the advice that follows from damage: delete it. Following that during a
    // momentary lock destroys a live backup's only stored copy of its settings,
    // so this branch must not offer deletion, and must name the read error.
    await fs.rm(path.join(root, '.bfs', 'config.json'));
    await fs.mkdir(path.join(root, '.bfs', 'config.json'));

    await expect(runInit(root, 'photos')).rejects.toThrow(BfsError);
    await expect(runInit(root, 'photos')).rejects.toThrow(/EISDIR|EPERM|EACCES/);
    await expect(runInit(root, 'photos')).rejects.not.toThrow(/delete|usuń/i);
  });

  it('should refuse an unreadable configuration without leaking a parser error', async () => {
    await runInit(root, 'docs');
    // A truncated config.json is the state an interrupted write leaves behind.
    // Reading it back through a plain JSON.parse raises SyntaxError - not a
    // BfsError - which would reach the operator as a bare parser message with
    // no way out, where today the directory is simply re-initializable.
    await fs.writeFile(path.join(root, '.bfs', 'config.json'), '{"vault_id": "trunc', 'utf-8');

    await expect(runInit(root, 'photos')).rejects.toThrow(BfsError);
  });
});
