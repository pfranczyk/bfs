import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeShardHeaderSize } from '../../src/core/shard-io.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { init, prune, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

// prune picks versions by number, so on its own it would happily remove the last
// version that can still be restored — a routine `--keep-last 1` over a backup
// whose newest version rotted would drop the operator's good copy and keep the
// unrecoverable one. The guard exists for exactly that case and stays out of the
// way otherwise: damaged versions remain deletable, and so does everything once
// nothing restorable is left.

const VAULT_NAME = 'prune-health';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** Flips one payload byte, leaving the trailing checksum stale — bit-rot. */
async function rotShardPayload(file: string): Promise<void> {
  const buf = await fs.readFile(file);
  const pos = computeShardHeaderSize(buf);
  buf[pos] ^= 0xff;
  await fs.writeFile(file, buf);
}

function shardPath(providerDir: string, shardIndex: number, version: number): string {
  return path.join(providerDir, VAULT_NAME, `shard_${shardIndex}.bfs.${version}`);
}

describe('prune guards the last restorable version', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    root = await mkTmp('bfs-prune-health-root-');
    pdirs = [await mkTmp('bfs-prune-health-p0-'), await mkTmp('bfs-prune-health-p1-'), await mkTmp('bfs-prune-health-p2-')];
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

    // Version 2 rots on two of three media: with N=2, one readable shard is not
    // enough to reconstruct it, and a deep verify records that verdict.
    await rotShardPayload(shardPath(pdirs[0], 0, 2));
    await rotShardPayload(shardPath(pdirs[1], 1, 2));
    const v2 = await verifyVersion(root, 2, io, { deep: true });
    expect(v2.health).toBe(VersionHealth.Damaged);
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should refuse to delete the only version that is still restorable', async () => {
    await expect(prune(root, { versions: [1], io })).rejects.toThrow(/still be restored/i);

    expect(await readManifest(root, 1)).not.toBeNull();
    await expect(fs.access(shardPath(pdirs[0], 0, 1))).resolves.toBeUndefined();
  });

  it('should delete a version when no remaining copy is restorable either', async () => {
    // Every version is damaged: there is no good copy left to protect, and
    // refusing here would make unrecoverable data impossible to clean up.
    await rotShardPayload(shardPath(pdirs[0], 0, 1));
    await rotShardPayload(shardPath(pdirs[1], 1, 1));
    expect((await verifyVersion(root, 1, io, { deep: true })).health).toBe(VersionHealth.Damaged);

    await prune(root, { versions: [1], io });

    expect(await readManifest(root, 1)).toBeNull();
  });

  it('should delete a damaged version even while a restorable one remains', async () => {
    await prune(root, { versions: [2], io });

    expect(await readManifest(root, 2)).toBeNull();
    expect(await readManifest(root, 1)).not.toBeNull();
  });
});
