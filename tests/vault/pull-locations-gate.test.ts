import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// `bfs recovery` rebuilds the provider addresses from a location map read out of
// a shard header - for a `--no-enc` copy that map carries no keyed integrity, so
// a tampered one can point at a host of someone else's choosing. Until the
// operator has seen those addresses, `locations_confirmed: false` stands, and the
// first write path (push, or a heal that uploads) shows them and asks.
//
// `pull` only reads, so it is deliberately not gated - but it does rewrite
// state.json for its own two fields, and `writeState` replaces the whole file.
// Writing only what it cares about drops the flag, and dropping it reads as
// confirmed: the push that follows sends data to those addresses without ever
// showing them. A pull that succeeded proves nothing about the storages it never
// reached - Reed-Solomon lets it finish while one of them is unreachable.

const VAULT_NAME = 'pull-locations-gate';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

describe('pull and the recovered-locations gate', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    root = await mkTmp('bfs-pull-gate-root-');
    pdirs = [await mkTmp('bfs-pull-gate-p0-'), await mkTmp('bfs-pull-gate-p1-'), await mkTmp('bfs-pull-gate-p2-')];
    io = createMockProviderIO({}, root, false).io;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });

    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should leave the gate up for the first write path', async () => {
    // The state a recovery leaves: addresses rebuilt from an untrusted map.
    await writeState(root, { latest_version: 1, working_version: 0, locations_confirmed: false });

    await pull(root, { io, force: true, yes: true });

    const state = await readState(root);
    expect(state.working_version, 'test setup: the pull must have run and rewritten the state').toBe(1);
    expect(state.locations_confirmed, 'reading from the storages says nothing about whether the operator approved sending data to them - and an absent flag reads as approved').toBe(false);
  });

  // The other direction: a completed push records the locations as confirmed, and
  // a pull must carry that through rather than reset it - otherwise every restore
  // would put the confirmation prompt back in front of an operator who already
  // answered it.
  it('should carry a confirmed copy through unchanged', async () => {
    const before = await readState(root);
    expect(before.locations_confirmed, 'test setup: a completed push confirms the locations').toBe(true);

    await pull(root, { io, force: true, yes: true });

    const state = await readState(root);
    expect(state.locations_confirmed, 'a pull neither grants nor withdraws that confirmation').toBe(true);
  });
});
