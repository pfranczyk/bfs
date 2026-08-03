import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { packBlob } from '../../src/core/blob-pack.js';
import { hashBuffer, SHA256_BYTES } from '../../src/core/hash.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import { rsEncode } from '../../src/core/reed-solomon.js';
import { buildShard, uuidToBuffer } from '../../src/core/shard-io.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, ShardHeader, ShardLocation, VaultConfig, VersionManifest } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { writeConfig } from '../../src/vault/config.js';
import { writeManifest } from '../../src/vault/manifest.js';
import { writeState } from '../../src/vault/state.js';
import { pull } from '../../src/vault/vault-manager.js';

// Backups written before the striped format are read by a separate path, and it
// classifies a failed part exactly as the current one does — damage is damage,
// absence is absence. What it says out loud has to agree: a per-medium notice
// claiming the data is gone, next to a closing sentence naming the same medium
// as damaged, leaves the operator with two contradictory next moves for one run.
//
// The failure text is asserted in English: t() answers in the default language
// here, no setLang() runs in unit tests.

const VAULT_NAME = 'legacy-v1-attribution';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function shardPath(providerDir: string, shardIndex: number): string {
  return path.join(providerDir, VAULT_NAME, `shard_${shardIndex}.bfs.1`);
}

/** Directory of medium `pN`, which holds shard N of version 1. */
function mediumDir(dirs: string[], index: number): string {
  const dir = dirs[index];
  if (dir === undefined) throw new Error(`fixture has no directory for medium p${index}`);
  return dir;
}

/**
 * Flips one byte of the shard's magic — bit-rot inside the header, so the part
 * is present and readable but its own description of itself no longer parses.
 */
async function rotShardHeader(file: string): Promise<void> {
  const buf = await fs.readFile(file);
  buf[0] ^= 0xff;
  await fs.writeFile(file, buf);
}

/**
 * Builds a genuine FORMAT_VERSION 1 vault by hand: unencrypted, flat (non-striped)
 * Reed-Solomon, V1 shard headers. Current `push` only emits V2, so a legacy V1
 * backup can only be produced synthetically. Provider `pN` owns `providerDirs[N]`
 * and shard N.
 */
async function synthesizeV1Vault(opts: { N: number; K: number }): Promise<{ root: string; providerDirs: string[] }> {
  const { N, K } = opts;
  const total = N + K;
  const root = await mkTmp('bfs-pull-v1-root-');
  const providerDirs: string[] = [];
  for (let i = 0; i < total; i++) providerDirs.push(await mkTmp(`bfs-pull-v1-p${i}-`));

  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');

  const vaultId = randomUUID();
  const { blob } = await packBlob(root, createIgnoreFilter(root), uuidToBuffer(vaultId));
  const blobHash = hashBuffer(blob.subarray(0, blob.length - SHA256_BYTES));
  const payloads = rsEncode(blob, N, K);

  const providers: ProviderConfig[] = [];
  for (let i = 0; i < total; i++) providers.push(localProvider(`p${i}`, mediumDir(providerDirs, i)));

  const remotePath = (j: number): string => [mediumDir(providerDirs, j), VAULT_NAME, `shard_${j}.bfs.1`].join('/').replace(/\\/g, '/');
  const locationMap: ShardLocation[] = providers.map((pc, j) => ({
    shard_index: j,
    provider_id: pc.id,
    provider_type: 'local',
    adapterPackage: null,
    connection_config: { path: mediumDir(providerDirs, j) },
    required_inputs: null,
    remote_path: remotePath(j),
    shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)),
  }));

  for (let i = 0; i < total; i++) {
    const header: ShardHeader = {
      magic: 'BFSS',
      format_version: 1,
      vault_id: vaultId,
      vault_name: VAULT_NAME,
      blob_size: BigInt(blob.length),
      blob_hash: blobHash,
      data_shards: N,
      parity_shards: K,
      shard_index: i,
      version: 1,
      encrypted: false,
      kdf_salt: null,
      rs_stripe_size: null,
      map_length: 0,
      location_map: locationMap,
    };
    const shard = buildShard(header, payloads[i] ?? Buffer.alloc(0));
    const dir = path.join(mediumDir(providerDirs, i), VAULT_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `shard_${i}.bfs.1`), shard);
  }

  const config: VaultConfig = {
    vault_id: vaultId,
    vault_name: VAULT_NAME,
    version: 1,
    scheme: { data_shards: N, parity_shards: K },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers,
    max_ram_mb: null,
  };
  await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
  await writeConfig(root, config);
  await writeState(root, { latest_version: 1, working_version: 1 });

  const manifest: VersionManifest = {
    version: 1,
    pushed_at: new Date().toISOString(),
    file_count: 2,
    total_size: 6,
    blob_hash: blobHash,
    scheme: { data_shards: N, parity_shards: K },
    encrypted: false,
    shards: providers.map((pc, j) => ({ shard_index: j, provider_id: pc.id, provider_type: 'local', remote_path: remotePath(j), shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)) })),
    health: VersionHealth.Healthy,
  };
  await writeManifest(root, manifest);

  return { root, providerDirs };
}

describe('pull attributes a failed restore of a legacy backup to the right cause', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;

  beforeEach(async () => {
    const built = await synthesizeV1Vault({ N: 2, K: 1 });
    root = built.root;
    pdirs = built.providerDirs;
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    logs = mock.logs;
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should report a damaged part of a legacy backup as damaged, not as absent', async () => {
    // Two parts rot in their headers: still on their media, still readable, only
    // their self-description is gone. The closing sentence gets this right, so
    // the per-medium notices printed moments earlier must not tell the operator
    // the data has vanished from those media.
    await rotShardHeader(shardPath(mediumDir(pdirs, 0), 0));
    await rotShardHeader(shardPath(mediumDir(pdirs, 1), 1));

    let message = '';
    try {
      await pull(root, { io, force: true });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toMatch(/damaged|integrity/i);
    const named = logs.filter((l) => l.level === 'warn').filter((l) => /\bp0\b|\bp1\b/.test(l.message));
    assert(named.length > 0, 'restore must say something about each medium it could not use');
    for (const warning of named) {
      expect(warning.message).not.toMatch(/missing/i);
    }
  });
});
