import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { init, push } from '../../src/vault/vault-manager.js';

// `bfs versions` reports how many files a version holds and how much they weigh,
// and the repo's convention for "we do not know" is null, which the table prints
// as `?`. A resume must therefore either report the real figures or admit it does
// not know them - reporting zero states, as fact, that the version is empty.
//
// The figures live in the blob's own file table, which a V2 blob carries per user
// file whether or not the data section is compressed. Compression is the default,
// so this is the ordinary path, not an edge case. Nothing repairs the value later
// either: the backfill in pull only fires when the field is null.

const VAULT_NAME = 'push-cache-manifest';
const CACHE_REL = path.join('.bfs', 'cache', 'push.blob.pending');
const FILES: ReadonlyArray<readonly [string, string]> = [
  ['a.txt', 'the quick brown fox'.repeat(64)],
  ['b.txt', 'jumps over the lazy dog'.repeat(32)],
  ['c.txt', 'pack my box with five dozen liquor jugs'.repeat(16)],
];

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

describe('push --cache records the same version figures a fresh push would', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  /**
   * Bytes the backup holds, uncompressed - the fixture files plus the .bfsignore
   * that init leaves behind, which round-trips through the blob like any other
   * file. Read from disk rather than assumed, so the figure stays exact.
   */
  async function expectedTotalSize(): Promise<number> {
    const fixtures = FILES.reduce((sum, [, body]) => sum + Buffer.byteLength(body, 'utf-8'), 0);
    const ignore = await fs.stat(path.join(root, '.bfsignore'));
    return fixtures + ignore.size;
  }

  /**
   * Leaves an interrupted push behind: the version degraded, one medium
   * unwritable, and the pending blob on disk for a resume to pick up.
   *
   * @param compressed - whether the backup compresses its data section
   */
  async function partialPush(compressed: boolean): Promise<void> {
    root = await mkTmp('bfs-cache-manifest-root-');
    pdirs = [await mkTmp('bfs-cache-manifest-a-'), await mkTmp('bfs-cache-manifest-b-'), await mkTmp('bfs-cache-manifest-c-')];
    io = createMockProviderIO({}, root, false).io;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: compressed, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    for (const [name, body] of FILES) {
      await fs.writeFile(path.join(root, name), body, 'utf-8');
    }

    const broken = pdirs[2];
    assert(broken !== undefined, 'fixture must have a third medium');
    await fs.rm(broken, { recursive: true, force: true });
    await fs.writeFile(broken, '', 'utf-8');

    const partial = await push(root, { io });
    expect(partial.health).toBe(VersionHealth.Degraded);
    await fs.access(path.join(root, CACHE_REL));

    await fs.rm(broken, { force: true });
    await fs.mkdir(broken, { recursive: true });
  }

  /**
   * Files the backup covers: everything under the working directory except the
   * `.bfs/` metadata tree, counted recursively so a nested fixture would not
   * silently drift away from what the blob records.
   */
  async function fileCountInBackup(dir: string = root): Promise<number> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.name === '.bfs') continue;
      count += entry.isDirectory() ? await fileCountInBackup(path.join(dir, entry.name)) : 1;
    }
    return count;
  }

  beforeEach(() => {
    root = '';
    pdirs = [];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should record the real file count and size when resuming a compressed backup', async () => {
    await partialPush(true);
    const expectedCount = await fileCountInBackup();
    const expectedSize = await expectedTotalSize();

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    const manifest = await readManifest(root, 1);
    assert(manifest !== null, 'resume must leave a manifest for version 1');
    expect(manifest.file_count).toBe(expectedCount);
    expect(manifest.total_size).toBe(expectedSize);
  });

  it('should describe the cached data, not the directory as it looks now', async () => {
    await partialPush(true);
    const expectedCount = await fileCountInBackup();
    const expectedSize = await expectedTotalSize();
    // A resume uploads a blob packed during the earlier run, and deliberately
    // skips the drift check because of it. The figures must therefore come from
    // that blob - counting the directory as it stands now would describe a
    // version nobody can restore.
    await fs.writeFile(path.join(root, 'added-after-packing.txt'), 'not in the cached blob', 'utf-8');

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    const manifest = await readManifest(root, 1);
    assert(manifest !== null, 'resume must leave a manifest for version 1');
    expect(manifest.file_count).toBe(expectedCount);
    expect(manifest.total_size).toBe(expectedSize);
  });

  it('should never report a version as empty when it holds files', async () => {
    await partialPush(true);

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    // Zero is not "unknown" - `bfs versions` prints it as a fact, and the pull
    // backfill only repairs a null, so the lie is permanent.
    const manifest = await readManifest(root, 1);
    assert(manifest !== null, 'resume must leave a manifest for version 1');
    expect(manifest.file_count).not.toBe(0);
    expect(manifest.total_size).not.toBe(0);
  });

  it('should record the same figures whether or not the backup is compressed', async () => {
    await partialPush(false);
    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });
    const uncompressed = await readManifest(root, 1);
    assert(uncompressed !== null, 'resume must leave a manifest for version 1');
    const plainCount = uncompressed.file_count;
    const plainSize = uncompressed.total_size;

    await fs.rm(root, { recursive: true, force: true });
    for (const d of pdirs) await fs.rm(d, { recursive: true, force: true });
    await partialPush(true);
    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    const compressed = await readManifest(root, 1);
    assert(compressed !== null, 'resume must leave a manifest for version 1');
    expect(compressed.file_count).toBe(plainCount);
    expect(compressed.total_size).toBe(plainSize);
  });
});
