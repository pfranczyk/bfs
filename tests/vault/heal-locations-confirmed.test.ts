import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/heal resolve by string "local".
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, VaultState } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, push, removeProvider } from '../../src/vault/vault-manager.js';

// ─── Contract under test (RED) ──────────────────────────────────────────────
//
// S3 (heal half) — "unconfirmed config after recovery" gate, write paths other
// than push.
//
// recover() reconstructs .bfs/config.json from a `--no-enc` shard's UNKEYED
// location map and marks state.locations_confirmed=false. push() now gates on
// that flag, but `bfs provider remove --strategy relocate|rebuild` (heal.ts via
// removeProvider) is ALSO a write path: it authenticates to every provider in
// the recovered config and uploads updated headers / a reconstructed shard.
// After a disaster recovery from a forged map, a heal therefore ships data to
// the attacker's host without the operator ever confirming the locations.
//
// The plan promises the gate fires on "push OR heal, whichever comes first".
//
// GREEN contract:
//   1. With locations_confirmed===false, removeProvider (relocate|rebuild) shows
//      the operator the provider locations and REQUIRES confirmation BEFORE
//      touching any provider. On denial it aborts without writing.
//   2. On confirmation it performs the heal and clears the flag
//      (locations_confirmed===true) so later operations run unprompted.
//   3. An absent flag (legacy state) = confirmed: no gate (covered by heal.test).
//
// Today (RED): removeProvider has no gate. A denied confirmation is ignored —
// relocate rewrites config and rebuild removes the provider — and the flag is
// never cleared. confirm() is never called, so the assertions below fail.

const VAULT_NAME = 'heal-test';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-heal-gate-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

/** IO that records every confirm() message and answers them all with `verdict`. */
function confirmingIO(verdict: boolean): { io: ProviderIO; confirms: string[] } {
  const base = createMockProviderIO();
  const confirms: string[] = [];
  const io: ProviderIO = {
    ...base.io,
    async confirm(message: string): Promise<boolean> {
      confirms.push(message);
      return verdict;
    },
  };
  return { io, confirms };
}

/**
 * Stands up a `--no-enc` 2/1 vault on three local providers, pushes v1, then
 * registers a fourth (unused) provider as a heal target and forces
 * state.locations_confirmed=false — the post-recovery condition the gate keys on.
 * Returns the four provider dirs (index 3 = rebuild target).
 */
async function setupUnconfirmed(): Promise<{ root: string; dirs: string[] }> {
  const root = await tmp();
  const dirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  await init(root, {
    vault_name: VAULT_NAME,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.slice(0, 3).map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: mockIO(),
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io: mockIO() });

  const config = await readConfig(root);
  if (!config) throw new Error('config missing after push');
  await writeConfig(root, { ...config, providers: [...config.providers, localProvider('p3', dirs[3] ?? '')] });

  const state = await readState(root);
  await writeState(root, { ...state, locations_confirmed: false } as VaultState);

  return { root, dirs };
}

async function cleanup(root: string, dirs: string[]): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
}

describe('removeProvider gates heal write paths on an unconfirmed recovered config', () => {
  beforeEach(() => {});
  afterEach(() => {});

  it('relocate should require location confirmation and abort without writing when declined', async () => {
    const { root, dirs } = await setupUnconfirmed();
    const newDir = await tmp();
    // Place p0's shard at the new address so relocate WOULD succeed if ungated —
    // that is what makes the decline meaningful (without the gate, config is
    // rewritten despite the denial).
    await fs.cp(path.join(dirs[0] ?? '', VAULT_NAME), path.join(newDir, VAULT_NAME), { recursive: true });

    const probe = confirmingIO(false);
    await expect(removeProvider(root, 'p0', { strategy: 'relocate', io: probe.io, newConnectionConfig: { path: newDir } })).rejects.toThrow();

    // GREEN: the operator was asked to confirm the locations.
    expect(probe.confirms.length).toBeGreaterThan(0);
    // ...and the denial left config untouched (p0 still points at its old dir).
    const config = await readConfig(root);
    expect(config?.providers.find((p) => p.id === 'p0')?.config.path).toBe(dirs[0]);

    await cleanup(root, [...dirs, newDir]);
  });

  it('rebuild should require location confirmation and abort without writing when declined', async () => {
    const { root, dirs } = await setupUnconfirmed();

    const probe = confirmingIO(false);
    await expect(removeProvider(root, 'p0', { strategy: 'rebuild', io: probe.io, targetProviderId: 'p3' })).rejects.toThrow();

    // GREEN: the operator was asked to confirm the locations.
    expect(probe.confirms.length).toBeGreaterThan(0);
    // ...and the denial aborted before heal removed p0 from config.
    const config = await readConfig(root);
    expect(config?.providers.some((p) => p.id === 'p0')).toBe(true);

    await cleanup(root, dirs);
  });

  it('rebuild should clear the unconfirmed flag after a confirmed heal', async () => {
    const { root, dirs } = await setupUnconfirmed();

    const probe = confirmingIO(true);
    await removeProvider(root, 'p0', { strategy: 'rebuild', io: probe.io, targetProviderId: 'p3' });

    // The operator confirmed the locations...
    expect(probe.confirms.length).toBeGreaterThan(0);
    // ...the heal ran (p0 removed from config)...
    const config = await readConfig(root);
    expect(config?.providers.some((p) => p.id === 'p0')).toBe(false);
    // ...and the gate is satisfied: the flag flips to true.
    const state = (await readState(root)) as VaultState & { locations_confirmed?: boolean };
    expect(state.locations_confirmed).toBe(true);

    await cleanup(root, dirs);
  });
});
