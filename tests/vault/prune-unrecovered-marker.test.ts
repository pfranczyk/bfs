import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, prune, push } from '../../src/vault/vault-manager.js';

// After a recovery that met a version it could not open, the copy still knows
// that version is out there: a marker sits in its place and `latest_version`
// counts it, so the next push builds past it. `prune` recomputes that number from
// what is left on disk - counting only complete manifests, it drops the number
// back below the marked version and re-opens the very path the marker exists to
// close: the next push claims a number that is taken and overwrites its parts.

const VAULT_NAME = 'prune-marker';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

describe('prune with a version present on the media but not recovered', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    root = await mkTmp('bfs-prune-marker-root-');
    pdirs = [await mkTmp('bfs-prune-marker-p0-'), await mkTmp('bfs-prune-marker-p1-'), await mkTmp('bfs-prune-marker-p2-')];
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
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa-updated', 'utf-8');
    await push(root, { io });

    // The state a recovery leaves when v3 was on the media but sealed under a
    // password nobody supplied: a marker in place of its manifest, and a version
    // counter that still accounts for it.
    await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v003.json'), '{}', 'utf-8');
    await writeState(root, { latest_version: 3, working_version: 2 });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should keep the latest version counting the unrecovered one', async () => {
    await prune(root, { versions: [1], io });

    const state = await readState(root);
    expect(state.latest_version, 'v3 is still on the media, so lowering the counter below it hands the next push a number that is taken').toBe(3);
  });

  // The gate a recovery puts up - locations came from an untrusted map, so the
  // first push must show them and be confirmed. `prune` rewrites the state for
  // its own field; writing only the fields it cares about drops the gate and the
  // next push goes straight to those locations without a word.
  it('should keep the recovered-locations gate up while rewriting the version counter', async () => {
    // The marker goes, so pruning the newest version actually lowers the counter
    // and the state is rewritten - the only moment the rest of it can be dropped.
    await fs.rm(path.join(root, '.bfs', 'manifests', 'v003.json'));
    await writeState(root, { latest_version: 2, working_version: 2, locations_confirmed: false });

    await prune(root, { versions: [2], io });

    const state = await readState(root);
    expect(state.latest_version, 'test setup: pruning the newest version must rewrite the counter').toBe(1);
    expect(state.locations_confirmed, 'pruning a version says nothing about whether the storage locations were confirmed').toBe(false);
  });

  it('should leave the marker in place when another version is pruned', async () => {
    await prune(root, { versions: [1], io });

    const marker = await fs.readFile(path.join(root, '.bfs', 'manifests', 'v003.json'), 'utf-8');
    expect(JSON.parse(marker), 'pruning one version must not disturb what is recorded about another').toEqual({});
  });
});
