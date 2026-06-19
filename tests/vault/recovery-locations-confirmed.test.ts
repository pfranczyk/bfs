import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderIO, VaultState } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { recover } from '../../src/vault/recovery.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { registerSecretProvider, SecretLocalProvider, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

// ─── Contract under test (RED) ──────────────────────────────────────────────
//
// S3 — "unconfirmed config after recovery" gate.
//
// With encryption off, a shard's location_map is raw JSON guarded only by an
// UNKEYED trailing SHA-256. `recover()` reconstructs .bfs/config.json straight
// from that untrusted map (host/path of every provider). If an attacker forged
// one shard, the recovered config now points a provider at the attacker's host.
// The escalation: the NEXT `bfs push` packs the local directory and ships shards
// to the attacker — a credential/data leak triggered by the operator's own push.
//
// GREEN contract:
//   1. recover() marks the recovered config as UNCONFIRMED — a flag in
//      state.json (VaultState.locations_confirmed === false).
//   2. The FIRST write operation to a medium after recovery (push) must show the
//      operator the provider locations and REQUIRE confirmation BEFORE uploading
//      anything. On denial it aborts without sending a single shard. On
//      confirmation it clears the flag (locations_confirmed === true) so later
//      pushes run unprompted.
//   3. A legacy state.json with no such field = treated as confirmed (true).
//
// Today (RED): VaultState has no locations_confirmed field, recover() never
// writes it, and push() never gates on it. The tests below therefore fail
// behaviourally — recovery leaves the flag absent and push uploads to the
// (attacker) provider without asking. The new field is referenced through a
// local cast so typecheck stays green until the GREEN code adds it to the type.

const VAULT_NAME = 'confirm-gate';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-confirm-'));
}

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

/** Reads state.json and exposes the (not-yet-typed) locations_confirmed field. */
async function readStateWithFlag(root: string): Promise<VaultState & { locations_confirmed?: boolean }> {
  return (await readState(root)) as VaultState & { locations_confirmed?: boolean };
}

/**
 * Stands up a `--no-enc` 2/1 vault on three SecretLocalProviders, pushes v1,
 * then deletes .bfs/ so recovery has to rebuild config/state from the remote
 * (stripped) shard headers. Mirrors the disaster setup used elsewhere.
 */
async function setupAndDestroy(root: string, dirs: string[]): Promise<void> {
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
  await init(root, {
    vault_name: VAULT_NAME,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.map((d, i) => secretProviderConfig(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: mockIO(),
  });
  await push(root, { io: mockIO() });
  await fs.rm(path.join(root, '.bfs'), { recursive: true });
}

describe('recover() marks the reconstructed config as unconfirmed', () => {
  beforeEach(() => registerSecretProvider());
  afterEach(() => unregisterSecretProvider());

  it('should write locations_confirmed=false to state.json after recovery', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupAndDestroy(root, dirs);

    const { io } = createMockProviderIO();
    const bootstrapProvider = new SecretLocalProvider(secretProviderConfig('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, bootstrapInputs: { password: 'shared-key' } });

    const state = await readStateWithFlag(root);
    // RED today: the field is absent (undefined), so this strict-false check fails.
    expect(state.locations_confirmed).toBe(false);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push() gates on an unconfirmed recovered config', () => {
  beforeEach(() => registerSecretProvider());
  afterEach(() => unregisterSecretProvider());

  /**
   * Builds an IO that records every confirm() message and answers them all with
   * the given verdict. Captures order so a test can prove the confirm happened
   * BEFORE the upload (no shard files on disk at confirm time).
   */
  function confirmingIO(verdict: boolean, dirs: string[]): { io: ProviderIO; confirms: string[]; shardsAtFirstConfirm: number } {
    const base = createMockProviderIO();
    const confirms: string[] = [];
    const tracker = { shardsAtFirstConfirm: -1 };
    const io: ProviderIO = {
      ...base.io,
      async confirm(message: string): Promise<boolean> {
        confirms.push(message);
        if (tracker.shardsAtFirstConfirm === -1) {
          // Count shard files present across all provider dirs at confirm time.
          let count = 0;
          for (const d of dirs) {
            const entries = await fs.readdir(path.join(d, VAULT_NAME)).catch(() => [] as string[]);
            count += entries.filter((e) => e.startsWith('shard_')).length;
          }
          tracker.shardsAtFirstConfirm = count;
        }
        return verdict;
      },
    };
    return {
      io,
      confirms,
      get shardsAtFirstConfirm(): number {
        return tracker.shardsAtFirstConfirm;
      },
    } as { io: ProviderIO; confirms: string[]; shardsAtFirstConfirm: number };
  }

  /** Recovers the vault, then forces state.locations_confirmed=false for the gate. */
  async function recoverUnconfirmed(root: string, dirs: string[]): Promise<void> {
    const { io } = createMockProviderIO();
    const bootstrapProvider = new SecretLocalProvider(secretProviderConfig('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();
    await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, bootstrapInputs: { password: 'shared-key' } });
    const state = await readState(root);
    await writeState(root, { ...state, locations_confirmed: false } as VaultState);
  }

  it('should require location confirmation BEFORE uploading any shard', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupAndDestroy(root, dirs);
    await recoverUnconfirmed(root, dirs);
    // Wipe the remote shards so any new shard file proves THIS push wrote it.
    for (const d of dirs) await fs.rm(path.join(d, VAULT_NAME), { recursive: true, force: true });

    const probe = confirmingIO(true, dirs);
    await push(root, { io: probe.io });

    // GREEN: push asks the operator to confirm provider locations first.
    expect(probe.confirms.length).toBeGreaterThan(0);
    // ...and it asks BEFORE any shard hits a provider directory.
    expect(probe.shardsAtFirstConfirm).toBe(0);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should abort without uploading when the operator declines the location confirmation', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupAndDestroy(root, dirs);
    await recoverUnconfirmed(root, dirs);
    for (const d of dirs) await fs.rm(path.join(d, VAULT_NAME), { recursive: true, force: true });

    const probe = confirmingIO(false, dirs);
    await expect(push(root, { io: probe.io })).rejects.toThrow();

    // RED today: push uploads regardless, so v2 shards land despite the denial.
    let uploaded = 0;
    for (const d of dirs) {
      const entries = await fs.readdir(path.join(d, VAULT_NAME)).catch(() => [] as string[]);
      uploaded += entries.filter((e) => e.startsWith('shard_')).length;
    }
    expect(uploaded).toBe(0);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should clear the unconfirmed flag after a confirmed push', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupAndDestroy(root, dirs);
    await recoverUnconfirmed(root, dirs);
    for (const d of dirs) await fs.rm(path.join(d, VAULT_NAME), { recursive: true, force: true });

    const probe = confirmingIO(true, dirs);
    await push(root, { io: probe.io });

    // After a confirmed push the gate is satisfied: the flag flips to true.
    const state = await readStateWithFlag(root);
    expect(state.locations_confirmed).toBe(true);

    // Config is intact (sanity — recovery rebuilt the three providers).
    const config = await readConfig(root);
    expect(config?.providers).toHaveLength(3);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});
