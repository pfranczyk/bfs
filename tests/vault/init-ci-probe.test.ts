import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { createMockProviderIO, type ProviderFactory, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderHelp, RemoteRef, StorageProvider, VerifyShardResult } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { init } from '../../src/vault/vault-manager.js';

// Regression guard for the `bfs init --ci` provider-setup gap: init verifies
// every provider BEFORE writing config, but its shared loop calls only the bare
// authenticate() (a connectivity probe) — never probeConnection(), the real
// setup check that creates the target directory and round-trips a write/read.
// Against a provider whose base directory does not exist yet (e.g. SSH, whose
// authenticate() is a plain readdir(basePath) that throws "No such file"),
// init --ci therefore aborts instead of creating + verifying the directory.
// The interactive path already probes; `provider add --ci` already probes; only
// `init --ci` regressed. This test fails until init's loop probes instead of
// authenticating.

const FAKE_TYPE = 'fake-missing-dir';

/**
 * In-memory medium shared by every fake provider instance in a test. Models a
 * remote whose directories must be created before they can be listed — exactly
 * the state a freshly-provisioned target is in before the first init.
 */
interface FakeMedium {
  /** Base paths that have been created (probeConnection's ensureDir). */
  readonly createdDirs: Set<string>;
  /** Base paths authenticate() was invoked against. */
  readonly authenticateCalls: string[];
  /** Base paths probeConnection() was invoked against. */
  readonly probeCalls: string[];
}

let medium: FakeMedium;

/**
 * Minimal StorageProvider modelling a remote whose base directory does not yet
 * exist. authenticate() is a BARE check (mirrors SSH's readdir(basePath)) that
 * REJECTS when the directory was never created; probeConnection() is the real
 * setup step that ensureDir's the directory (and would round-trip a write/read).
 * Only the three methods init() touches carry behaviour; the rest throw to prove
 * init never reaches them.
 */
class FakeMissingDirProvider implements StorageProvider {
  readonly id: string;
  readonly type: string;
  private readonly basePath: string;
  private vaultName = '';

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.type = config.type;
    this.basePath = String((config.config as { path?: unknown }).path ?? '');
  }

  async authenticate(): Promise<void> {
    medium.authenticateCalls.push(this.basePath);
    if (!medium.createdDirs.has(this.basePath)) {
      // Same failure shape as SSH readdir() on a not-yet-created base path.
      throw new ProviderError(`ENOENT: no such file or directory, scandir '${this.basePath}'`);
    }
  }

  setVaultName(name: string): void {
    this.vaultName = name;
  }

  async probeConnection(): Promise<void> {
    // Mirrors SshProvider.vaultPath(): probing before setVaultName() is a
    // contract violation and throws. This forces the fix to order setVaultName()
    // BEFORE probeConnection() — a wrong-order fix (probe first) would otherwise
    // pass this test yet break the real SSH provider (whose vaultPath() throws).
    if (this.vaultName === '') {
      throw new ProviderError('setVaultName() must be called before any file operation');
    }
    // ensureDir(vaultDir) creates the base path as a parent — the setup step
    // init's authenticate()-only loop skips.
    medium.probeCalls.push(this.basePath);
    medium.createdDirs.add(this.basePath);
  }

  private unreachable(): never {
    throw new Error('FakeMissingDirProvider: method not reachable in the init() scenario');
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
  async list(): Promise<RemoteRef[]> {
    return this.unreachable();
  }
  async getSize(): Promise<number> {
    return this.unreachable();
  }
  async downloadHeader(): Promise<Buffer> {
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
  usesSidecar(): boolean {
    return false;
  }
  async uploadHeaderSidecar(): Promise<void> {
    return this.unreachable();
  }
  async downloadHeaderSidecar(): Promise<Buffer | null> {
    return this.unreachable();
  }
  async verifyShard(): Promise<VerifyShardResult> {
    return this.unreachable();
  }
}

const fakeFactory: ProviderFactory = {
  lang: 'en',
  displayName: 'Fake (missing dir)',
  create(config: ProviderConfig): StorageProvider {
    return new FakeMissingDirProvider(config);
  },
  help(): ProviderHelp {
    return { usage: '', description: '', flags: [], examples: [] };
  },
};

describe('init --ci provider setup (base directory does not exist)', () => {
  let root: string;
  const providerPaths = ['/fake-medium/p0', '/fake-medium/p1', '/fake-medium/p2'];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-ci-'));
    medium = { createdDirs: new Set<string>(), authenticateCalls: [], probeCalls: [] };
    providerRegistry.register(FAKE_TYPE, fakeFactory);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should create and verify each provider directory via probeConnection so init succeeds when the base directory does not exist yet', async () => {
    const providers: ProviderConfig[] = providerPaths.map((p, i) => ({ id: `p${i}`, type: FAKE_TYPE, adapterPackage: null, config: { path: p } }));

    // --ci path: non-interactive IO; none of the provider base dirs exist yet.
    const { io } = createMockProviderIO({}, root, false);

    await expect(
      init(root, { vault_name: 'v', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, providers, push_mode: PushMode.NewVersion, io }),
    ).resolves.toBeUndefined();

    // The real setup check ran for every provider and created its directory —
    // the step init's authenticate()-only loop skips.
    expect(medium.probeCalls.slice().sort()).toEqual(providerPaths.slice().sort());
    for (const p of providerPaths) {
      expect(medium.createdDirs.has(p)).toBe(true);
    }

    // init completed fully — config persisted with all three providers.
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).toEqual(['p0', 'p1', 'p2']);
  });
});
