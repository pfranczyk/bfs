import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultConfig, VersionManifest } from '../../src/types/index.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// A `rebuild` onto a brand-new target has to persist that target before calling
// removeProvider - the heal path re-reads the config from disk to find it. When
// the removal then fails, the extra medium stays behind and the vault carries
// one provider more than its scheme demands, so push, pull and prune all refuse
// until the operator undoes it by hand.
//
// The rollback is conditional, and the condition can only be read AFTER the
// failure: rebuildAllVersions repairs version by version, so it can move some
// versions onto the new target before failing on a later one. Those manifests
// already point at it, and dropping it from the config would orphan real data.
// The manifests read when the command started cannot show that - at that moment
// the target did not exist yet.

const hoisted = vi.hoisted(() => ({ stored: null as Nullable<VaultConfig> }));

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(async () => (hoisted.stored === null ? null : structuredClone(hoisted.stored))),
  writeConfig: vi.fn(async (_rootDir: string, config: VaultConfig) => {
    hoisted.stored = structuredClone(config);
  }),
}));
vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn(), removeProvider: vi.fn() }));

import { ExitPromptError } from '@inquirer/core';
import { BfsError } from '../../src/core/errors.js';
import { setLang } from '../../src/i18n/index.js';
import { listVersions, removeProvider } from '../../src/vault/vault-manager.js';

/** Manifest whose shards sit on the given providers, in order. */
function manifestOn(providerIds: string[]): VersionManifest {
  const shards = providerIds.map((id, i) => ({ shard_index: i, provider_id: id, provider_type: 'local', remote_path: `/tmp/${id}/v/shard_${i}.bfs.1`, shard_hash: 'h' }));
  return { version: 1, health: 'healthy', shards } as unknown as VersionManifest;
}

/** Ids currently persisted in the vault config. */
function storedProviderIds(): string[] {
  return (hoisted.stored?.providers ?? []).map((p) => p.id);
}

const REBUILD_ARGS = ['provider', 'remove', 'dysk-1', '--strategy', 'rebuild', '--target', 'dysk-4', '--new-type', 'local', '--path', '/tmp/d4', '--scope', 'all'];

describe('provider remove - config after a failed rebuild', () => {
  let console_: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    setLang('en');
    hoisted.stored = makeConfig() as unknown as VaultConfig;
    vi.mocked(removeProvider).mockRejectedValue(new BfsError('rebuild failed'));
    console_ = captureConsole();
  });

  afterEach(() => {
    console_.restore();
    vi.clearAllMocks();
  });

  /** Everything the command printed, whichever stream it chose. */
  function output(): string {
    return [...console_.logs, ...console_.errors].join('\n');
  }

  it('should drop the freshly added target when the rebuild failed before using it', async () => {
    vi.mocked(listVersions).mockResolvedValue([manifestOn(['dysk-1', 'dysk-2', 'dysk-3'])]);

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('abort');
    expect(storedProviderIds()).toEqual(['dysk-1', 'dysk-2', 'dysk-3']);
    expect(output()).toContain('has been removed again');
  });

  it('should keep the added target once a version was already rebuilt onto it', async () => {
    // The command's own opening read cannot know this: at that point the target
    // did not exist. Only a read taken after the failure sees the moved shard.
    vi.mocked(listVersions)
      .mockResolvedValueOnce([manifestOn(['dysk-1', 'dysk-2', 'dysk-3'])])
      .mockResolvedValue([manifestOn(['dysk-4', 'dysk-2', 'dysk-3'])]);

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('abort');
    expect(storedProviderIds()).toContain('dysk-4');
    expect(output()).toContain('stays in the configuration');
  });

  it('should still drop the target when a manifest names it from an earlier life', async () => {
    // The id carries a reference at a shard index the removed provider never
    // owned - a leftover, not data this rebuild produced. Reading it as rebuilt
    // data would strand exactly the entry this path exists to withdraw.
    vi.mocked(listVersions).mockResolvedValue([manifestOn(['dysk-1', 'dysk-2', 'dysk-4'])]);

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('abort');
    expect(storedProviderIds()).not.toContain('dysk-4');
  });

  it('should keep the added target when a manifest cannot be read after the failure', async () => {
    // An unparseable manifest is dropped from the listing, so nothing proves the
    // target is unused - and a wrong withdrawal orphans a part that is really there.
    vi.mocked(listVersions)
      .mockResolvedValueOnce([manifestOn(['dysk-1', 'dysk-2', 'dysk-3'])])
      .mockResolvedValue([]);

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('abort');
    expect(storedProviderIds()).toContain('dysk-4');
  });

  it('should drop the added target when the operator cancelled a prompt the rebuild raised', async () => {
    // A rebuild raises prompts of its own - a server identity to trust, the
    // post-recovery location gate. Ctrl+C there leaves the vault one provider
    // over its scheme exactly as an error does, so it takes the same path out.
    vi.mocked(listVersions).mockResolvedValue([manifestOn(['dysk-1', 'dysk-2', 'dysk-3'])]);
    vi.mocked(removeProvider).mockRejectedValue(new ExitPromptError('cancelled'));

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('cancelled');
    expect(storedProviderIds()).toEqual(['dysk-1', 'dysk-2', 'dysk-3']);
  });

  it('should leave the configuration alone when the removal itself already committed', async () => {
    // The old provider is gone from the config, so the scheme already balances.
    // Withdrawing the target here would take the vault BELOW its own scheme.
    vi.mocked(listVersions).mockResolvedValue([manifestOn(['dysk-1', 'dysk-2', 'dysk-3'])]);
    vi.mocked(removeProvider).mockImplementation(async () => {
      const config = hoisted.stored;
      if (config === null) throw new BfsError('no config');
      hoisted.stored = { ...config, providers: config.providers.filter((p) => p.id !== 'dysk-1') };
      throw new BfsError('follow-up state write failed');
    });

    const outcome = await runCmd(REBUILD_ARGS);

    expect(outcome).toBe('abort');
    expect(storedProviderIds()).toEqual(['dysk-2', 'dysk-3', 'dysk-4']);
    expect(output()).not.toContain('has been removed again');
  });
});
