import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnoent, writeJsonAtomic } from '../core/fs-utils.js';
import type { VersionManifest } from '../types/index.js';
import { VersionHealth } from '../types/index.js';

const KNOWN_HEALTH: ReadonlySet<string> = new Set<string>(Object.values(VersionHealth));

/** Manifest filename, capturing the version number it stands for. */
const MANIFEST_FILENAME = /^v(\d+)\.json$/;

/** Returns the filesystem path for a manifest file given the version number. */
function manifestFilePath(rootDir: string, version: number): string {
  const padded = String(version).padStart(3, '0');
  return path.join(rootDir, '.bfs', 'manifests', `v${padded}.json`);
}

/** True when `value` carries every field of a ManifestShard with the right type. */
function isManifestShard(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const shard = value as Record<string, unknown>;
  return typeof shard.shard_index === 'number' && typeof shard.provider_id === 'string' && typeof shard.provider_type === 'string' && typeof shard.remote_path === 'string' && typeof shard.shard_hash === 'string';
}

/** True when `value` carries both shard counts of a manifest scheme. */
function hasManifestScheme(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const scheme = value as Record<string, unknown>;
  return typeof scheme.data_shards === 'number' && typeof scheme.parity_shards === 'number';
}

/**
 * Decides whether a parsed JSON document is a manifest this BFS can act on.
 *
 * Consumers read a manifest without re-checking it - repair walks `shards`,
 * listManifests sorts on `version`, the prune guard decides a version is still
 * restorable from `health` - so a document missing any of them answers those
 * questions with undefined and silently misleads every one of them. The optional
 * fields (rs_striped, compressed, health_deep_rot, ...) are deliberately not
 * required: they arrived after the manifests that predate them, which stay
 * readable. An empty `shards` array is likewise accepted, because a push whose
 * every upload failed records exactly that and the operator needs to see the
 * version behind it.
 */
function isCompleteManifest(value: unknown): value is VersionManifest {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.version !== 'number' || !Number.isFinite(manifest.version)) return false;
  if (typeof manifest.blob_hash !== 'string') return false;
  if (typeof manifest.encrypted !== 'boolean') return false;
  if (typeof manifest.health !== 'string' || !KNOWN_HEALTH.has(manifest.health)) return false;
  if (manifest.pushed_at !== null && typeof manifest.pushed_at !== 'string') return false;
  if (manifest.file_count !== null && typeof manifest.file_count !== 'number') return false;
  if (manifest.total_size !== null && typeof manifest.total_size !== 'number') return false;
  if (!hasManifestScheme(manifest.scheme)) return false;
  return Array.isArray(manifest.shards) && manifest.shards.every(isManifestShard);
}

/** Parses manifest bytes, returning null when they hold anything but a complete manifest. */
function parseManifest(content: string): Nullable<VersionManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  return isCompleteManifest(parsed) ? parsed : null;
}

/**
 * Reads a single version manifest.
 *
 * A file holding anything but a complete manifest - truncated by an interrupted
 * write, or parsing cleanly while carrying none of the expected fields - reads
 * the same as a missing one. Callers already handle "no such version"; handing
 * them a half-manifest instead would push that decision into every one of them.
 * An unreadable file is a different matter: EACCES says the version is right
 * there, so it still throws rather than posing as absent.
 *
 * @returns VersionManifest, or null when the file is missing or incomplete.
 * @throws on read errors other than ENOENT.
 */
export async function readManifest(rootDir: string, version: number): Promise<Nullable<VersionManifest>> {
  let content: string;
  try {
    content = await fs.readFile(manifestFilePath(rootDir, version), 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
  return parseManifest(content);
}

/**
 * Writes a version manifest to .bfs/manifests/vNNN.json (pretty-printed JSON),
 * creating the directory if it is missing.
 *
 * The write goes to a temp file and renames onto the destination, so a run that
 * dies partway leaves the previously stored manifest whole. A manifest is
 * rewritten in place on every health change, and that is the one moment a
 * complete record of where a version's shards live could otherwise be destroyed.
 * Manifests carry provider coordinates (host, user, path) for every shard, so the
 * temp file is created 0600 and the rename carries that mode onto the
 * destination - a no-op on Windows NTFS, which is ACL-based.
 *
 * Partial-commit tolerance: manifest.shards may contain fewer than
 * scheme.data_shards + scheme.parity_shards entries - the writer makes no
 * assumption about completeness. Health field carries the actual state
 * (Healthy / Degraded / Damaged) as determined by the caller.
 *
 * @throws on write failure.
 */
export async function writeManifest(rootDir: string, manifest: VersionManifest): Promise<void> {
  await writeJsonAtomic(manifestFilePath(rootDir, manifest.version), manifest);
}

/**
 * Lists all version manifests found in .bfs/manifests/, sorted ascending by version.
 *
 * Silently skips every file that is not a complete manifest - unreadable, not
 * parsable, or parsing while carrying none of the expected fields. Listing must
 * not die on one bad file, and a record that answers `version` with undefined
 * would land in the sort comparison as NaN.
 *
 * @returns Array of VersionManifest objects.
 */
export async function listManifests(rootDir: string): Promise<VersionManifest[]> {
  const dir = path.join(rootDir, '.bfs', 'manifests');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const manifests: VersionManifest[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('v') || !entry.endsWith('.json')) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, entry), 'utf-8');
    } catch {
      continue; // skip unreadable manifests
    }
    const manifest = parseManifest(content);
    if (manifest !== null) manifests.push(manifest);
  }
  return manifests.sort((a, b) => a.version - b.version);
}

/** True when these bytes are the record of a version found but not recovered. */
function isUnrecoveredMarker(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  // `typeof null === 'object'`, and an array reports no own enumerable keys the
  // same way an empty object does - neither is the marker.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  return Object.keys(parsed).length === 0;
}

/**
 * Records that a version exists on the storage but has not been recovered - its
 * location map is sealed under a password that was not supplied.
 *
 * The record takes the version's own manifest path and holds nothing, so it can
 * never be mistaken for a manifest: every reader that wants one gets the same
 * answer as for a missing file. Recovering the version later writes the real
 * manifest over it, and the two states can never both describe one version.
 *
 * @throws on write failure.
 */
export async function writeUnrecoveredMarker(rootDir: string, version: number): Promise<void> {
  await writeJsonAtomic(manifestFilePath(rootDir, version), {});
}

/**
 * Lists the versions this directory knows exist on the storage without being
 * able to describe them, ascending.
 *
 * Only a record holding nothing counts. A file damaged in some other way is not
 * a promise that the version is waiting - it is a file this directory cannot
 * read - so it stays out, exactly as it stays out of the manifest readers.
 *
 * @returns Ascending version numbers, empty when there are none.
 * @throws on readdir failure other than ENOENT.
 */
export async function listUnrecoveredVersions(rootDir: string): Promise<number[]> {
  const dir = path.join(rootDir, '.bfs', 'manifests');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err: unknown) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const versions: number[] = [];
  for (const entry of entries) {
    const matched = MANIFEST_FILENAME.exec(entry);
    if (!matched?.[1]) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, entry), 'utf-8');
    } catch {
      continue; // unreadable file - skip, as the manifest listing does
    }
    if (isUnrecoveredMarker(content)) versions.push(Number(matched[1]));
  }
  return versions.sort((a, b) => a - b);
}

/**
 * Deletes the manifest file for the given version.
 * @throws on unlink failure (including ENOENT).
 */
export async function deleteManifest(rootDir: string, version: number): Promise<void> {
  await fs.unlink(manifestFilePath(rootDir, version));
}

/**
 * Records a health change that comes from altering the stored data itself - a
 * rebuilt shard, a removed provider - rather than from a verify pass.
 *
 * Verify provenance (`health_deep_rot`, `health_checked_at`) is cleared, because
 * it describes a check performed against the previous state of the media: keeping
 * it would let a stale "payload rot was read off the media" claim outlive the
 * repair that fixed it. The next verify re-establishes both.
 *
 * `deepRot` is the exception: a repair streams every sibling in full and checks
 * its trailing SHA-256, so when it finds rot it has read the bytes at the depth
 * `verify --deep` reads them. Recording that keeps the verdict alive past the
 * next shallow verify, which is blind to payload rot by construction and would
 * otherwise see every part present and stamp healthy again.
 *
 * @param manifest - Manifest to update in place
 * @param health   - Health the caller determined from the change it just made
 * @param deepRot  - True when this change rests on rot the caller read off the media
 * @returns the same manifest, for use in a write call
 */
export function applyHealthChange(manifest: VersionManifest, health: VersionHealth, deepRot = false): VersionManifest {
  manifest.health = health;
  if (deepRot) {
    manifest.health_deep_rot = true;
    manifest.health_checked_at = new Date().toISOString();
    return manifest;
  }
  delete manifest.health_deep_rot;
  delete manifest.health_checked_at;
  return manifest;
}
