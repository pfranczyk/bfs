import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionManifest } from '../../src/types/index.js';
import { VersionHealth } from '../../src/types/index.js';
import { listManifests, listUnrecoveredVersions, readManifest, writeManifest, writeUnrecoveredMarker } from '../../src/vault/manifest.js';

// A manifest is the only local record of where a version's shards live, so every
// consumer reads it without re-checking its shape: repair calls
// `m.shards.some(...)`, listManifests sorts by `a.version - b.version`, and the
// prune guard keeps a version alive by testing `m.health !== Damaged`. A file that
// parses but carries none of those fields answers each of them with undefined - a
// shape a `JSON.parse(...) as VersionManifest` cast waves through. These pin the
// gate that makes an incomplete manifest indistinguishable from a missing one.

const MANIFEST_DIR = path.join('.bfs', 'manifests');

/** A manifest carrying every field a completed push records. */
function completeManifest(version: number): VersionManifest {
  return {
    version,
    pushed_at: '2026-01-02T03:04:05.000Z',
    file_count: 2,
    total_size: 6,
    blob_hash: 'a'.repeat(64),
    scheme: { data_shards: 2, parity_shards: 1 },
    encrypted: false,
    shards: [
      { shard_index: 0, provider_id: 'p0', provider_type: 'local', remote_path: '/p0/v/shard_0.bfs.1', shard_hash: 'b'.repeat(64) },
      { shard_index: 1, provider_id: 'p1', provider_type: 'local', remote_path: '/p1/v/shard_1.bfs.1', shard_hash: 'c'.repeat(64) },
      { shard_index: 2, provider_id: 'p2', provider_type: 'local', remote_path: '/p2/v/shard_2.bfs.1', shard_hash: 'd'.repeat(64) },
    ],
    health: VersionHealth.Healthy,
  };
}

describe('manifest shape gate', () => {
  let root: string;

  /** Writes raw bytes as the manifest of `version`, bypassing writeManifest. */
  async function writeRaw(version: number, content: string): Promise<void> {
    await fs.writeFile(path.join(root, MANIFEST_DIR, `v${String(version).padStart(3, '0')}.json`), content, 'utf-8');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-manifest-'));
    await fs.mkdir(path.join(root, MANIFEST_DIR), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('readManifest', () => {
    it('should return a complete manifest unchanged', async () => {
      const manifest = completeManifest(1);
      await writeManifest(root, manifest);

      const read = await readManifest(root, 1);

      expect(read).toEqual(manifest);
    });

    it('should accept the null-valued fields a recovered manifest carries', async () => {
      const manifest: VersionManifest = { ...completeManifest(1), pushed_at: null, file_count: null, total_size: null, health: VersionHealth.Degraded };
      await writeManifest(root, manifest);

      const read = await readManifest(root, 1);

      expect(read).toEqual(manifest);
    });

    // A push whose every upload fails still records the version: `_writePushResults`
    // in src/vault/push-pipeline.ts writes the manifest unconditionally and gates
    // only state.json on having placed a part. An empty shard list is therefore a
    // shape BFS produces itself, and the version behind it is the one the operator
    // most needs to see in `bfs versions` - losing it to the gate would put whatever
    // did land on the media out of the tool's reach.
    it('should accept a manifest whose upload placed no shards at all', async () => {
      const manifest: VersionManifest = { ...completeManifest(1), shards: [], health: VersionHealth.Damaged };
      await writeManifest(root, manifest);

      const read = await readManifest(root, 1);

      expect(read).toEqual(manifest);
    });

    it('should return null when the manifest file does not exist', async () => {
      const read = await readManifest(root, 7);

      expect(read).toBeNull();
    });

    it('should return null for a manifest truncated mid-write', async () => {
      const full = JSON.stringify(completeManifest(1), null, 2);
      await writeRaw(1, full.slice(0, Math.floor(full.length / 2)));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null for an empty object that parses but carries no version', async () => {
      await writeRaw(1, '{}');

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the shard list is missing', async () => {
      const { shards: _shards, ...withoutShards } = completeManifest(1);
      await writeRaw(1, JSON.stringify(withoutShards));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the shard list is not an array', async () => {
      await writeRaw(1, JSON.stringify({ ...completeManifest(1), shards: { '0': 'p0' } }));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when a shard entry lacks its provider reference', async () => {
      const manifest = completeManifest(1);
      const [first, ...rest] = manifest.shards;
      assert(first !== undefined, 'fixture must carry at least one shard entry');
      const { provider_id: _providerId, ...crippled } = first;
      await writeRaw(1, JSON.stringify({ ...manifest, shards: [crippled, ...rest] }));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the scheme is missing its parity count', async () => {
      await writeRaw(1, JSON.stringify({ ...completeManifest(1), scheme: { data_shards: 2 } }));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the version number is not a number', async () => {
      await writeRaw(1, JSON.stringify({ ...completeManifest(1), version: '1' }));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when health carries a value outside the known set', async () => {
      await writeRaw(1, JSON.stringify({ ...completeManifest(1), health: 'restorable' }));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the blob hash is missing', async () => {
      const { blob_hash: _blobHash, ...withoutHash } = completeManifest(1);
      await writeRaw(1, JSON.stringify(withoutHash));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the encryption flag is missing', async () => {
      const { encrypted: _encrypted, ...withoutFlag } = completeManifest(1);
      await writeRaw(1, JSON.stringify(withoutFlag));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null when the version number is not finite', async () => {
      // JSON has no Infinity literal, but an exponent past the double range parses
      // into one - and a non-finite version would sort as NaN against its siblings.
      await writeRaw(1, JSON.stringify(completeManifest(1)).replace('"version":1', '"version":1e999'));

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    it('should return null for a JSON document that is not an object', async () => {
      await writeRaw(1, '"v001"');

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    // JSON `null` parses to a value that is `typeof 'object'`, so it reaches every
    // field check as a property read on null - a TypeError thrown out of a reader
    // that promises to answer with null.
    it('should return null for a JSON null document', async () => {
      await writeRaw(1, 'null');

      const read = await readManifest(root, 1);

      expect(read).toBeNull();
    });

    // An unreadable manifest is not an absent one: turning EACCES into null would
    // report "no such version" for a version that is right there, and send the
    // operator hunting for shards instead of fixing a permission.
    it('should rethrow a read failure that is not a missing file', async () => {
      const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const originalReadFile = fs.readFile.bind(fs);
      vi.spyOn(fs, 'readFile').mockImplementation(async (target: Parameters<typeof fs.readFile>[0], opts?: unknown) => {
        if (typeof target === 'string' && target.endsWith('v001.json')) throw denied;
        return originalReadFile(target, opts as Parameters<typeof fs.readFile>[1]);
      });

      const outcome = await readManifest(root, 1).then(
        () => 'resolved',
        (err: unknown) => err,
      );

      expect(outcome).toBe(denied);
    });
  });

  describe('listManifests', () => {
    it('should list complete manifests sorted ascending by version', async () => {
      await writeManifest(root, completeManifest(3));
      await writeManifest(root, completeManifest(1));
      await writeManifest(root, completeManifest(2));

      const listed = await listManifests(root);

      expect(listed.map((m) => m.version)).toEqual([1, 2, 3]);
    });

    it('should skip an empty-object manifest and keep the rest sorted', async () => {
      await writeManifest(root, completeManifest(1));
      await writeRaw(2, '{}');
      await writeManifest(root, completeManifest(3));

      const listed = await listManifests(root);

      expect(listed.map((m) => m.version)).toEqual([1, 3]);
    });

    it('should skip a manifest truncated mid-write', async () => {
      await writeManifest(root, completeManifest(1));
      const full = JSON.stringify(completeManifest(2), null, 2);
      await writeRaw(2, full.slice(0, 20));

      const listed = await listManifests(root);

      expect(listed.map((m) => m.version)).toEqual([1]);
    });

    it('should return an empty array when the manifests directory is absent', async () => {
      await fs.rm(path.join(root, MANIFEST_DIR), { recursive: true, force: true });

      const listed = await listManifests(root);

      expect(listed).toEqual([]);
    });
  });

  // A version recovery found on the media but could not open - the password that
  // seals its location map was not among the ones offered - is recorded as a file
  // with nothing in it. That record answers a question no other state can: the
  // version exists out there, and only a password stands between the operator and
  // it. An absent file keeps meaning the version does not exist, so `pull` can
  // still refuse a pruned version without touching the network.
  describe('unrecovered-version markers', () => {
    it('should list a version whose marker was written', async () => {
      await writeUnrecoveredMarker(root, 2);

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([2]);
    });

    it('should list markers sorted ascending, ignoring complete manifests', async () => {
      await writeManifest(root, completeManifest(1));
      await writeUnrecoveredMarker(root, 4);
      await writeUnrecoveredMarker(root, 2);

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([2, 4]);
    });

    it('should keep a marker out of the manifest readers', async () => {
      await writeUnrecoveredMarker(root, 2);

      const listed = await listManifests(root);

      expect(listed).toEqual([]);
      expect(await readManifest(root, 2)).toBeNull();
    });

    // A truncated file is damage, not a promise: advertising it as "waiting for
    // your password" would send the operator after a version this directory
    // cannot describe. Only an object with nothing in it is the marker.
    it('should not treat a truncated manifest as a marker', async () => {
      const full = JSON.stringify(completeManifest(2), null, 2);
      await writeRaw(2, full.slice(0, 20));

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([]);
    });

    it('should not treat a JSON document that is not an object as a marker', async () => {
      await writeRaw(2, '[]');

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([]);
    });

    // `typeof null === 'object'`, so a document of `null` reaches an emptiness
    // check that reads its keys - and takes `bfs versions` down with it.
    it('should not treat a JSON null document as a marker', async () => {
      await writeRaw(2, 'null');

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([]);
    });

    it('should return an empty list when the manifests directory is absent', async () => {
      await fs.rm(path.join(root, MANIFEST_DIR), { recursive: true, force: true });

      const unrecovered = await listUnrecoveredVersions(root);

      expect(unrecovered).toEqual([]);
    });

    // The marker takes the version's own manifest path, so restoring the version
    // later replaces it - the two states can never both describe one version.
    it('should be replaced by the manifest once the version is recovered', async () => {
      await writeUnrecoveredMarker(root, 2);
      const manifest = completeManifest(2);

      await writeManifest(root, manifest);

      expect(await listUnrecoveredVersions(root)).toEqual([]);
      expect(await readManifest(root, 2)).toEqual(manifest);
    });
  });

  describe('writeManifest', () => {
    it('should roundtrip through readManifest', async () => {
      const manifest = completeManifest(2);
      await writeManifest(root, manifest);

      const read = await readManifest(root, 2);

      expect(read).toEqual(manifest);
    });

    // A manifest is rewritten in place on every health change, so a write that dies
    // partway through is the one moment the previous, complete record can be
    // destroyed. Writing to a temp file and renaming keeps the destination whole:
    // the failed attempt leaves it exactly as it was.
    it('should leave the stored manifest intact when the write fails partway', async () => {
      const stored = completeManifest(1);
      await writeManifest(root, stored);
      const target = path.join(root, MANIFEST_DIR, 'v001.json');
      const originalWriteFile = fs.writeFile.bind(fs);
      vi.spyOn(fs, 'writeFile').mockImplementation(async (file: Parameters<typeof fs.writeFile>[0], data: Parameters<typeof fs.writeFile>[1], options?: Parameters<typeof fs.writeFile>[2]) => {
        await originalWriteFile(file, String(data).slice(0, 12), options);
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      });

      await expect(writeManifest(root, { ...stored, health: VersionHealth.Degraded })).rejects.toThrow(/no space left/);

      expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual(stored);
    });
  });
});
