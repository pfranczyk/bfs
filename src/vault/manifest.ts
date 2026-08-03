import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnoent } from '../core/fs-utils.js';
import type { VersionHealth, VersionManifest } from '../types/index.js';

/** Returns the filesystem path for a manifest file given the version number. */
function manifestFilePath(rootDir: string, version: number): string {
  const padded = String(version).padStart(3, '0');
  return path.join(rootDir, '.bfs', 'manifests', `v${padded}.json`);
}

/**
 * Reads a single version manifest.
 * @returns VersionManifest or null if not found.
 * @throws on read/parse errors other than ENOENT.
 */
export async function readManifest(rootDir: string, version: number): Promise<Nullable<VersionManifest>> {
  try {
    const content = await fs.readFile(manifestFilePath(rootDir, version), 'utf-8');
    return JSON.parse(content) as VersionManifest;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Writes a version manifest to .bfs/manifests/vNNN.json (pretty-printed JSON).
 * The .bfs/manifests directory must already exist.
 *
 * Partial-commit tolerance: manifest.shards may contain fewer than
 * scheme.data_shards + scheme.parity_shards entries — the writer makes no
 * assumption about completeness. Health field carries the actual state
 * (Healthy / Degraded / Damaged) as determined by the caller.
 *
 * @throws on write failure.
 */
export async function writeManifest(rootDir: string, manifest: VersionManifest): Promise<void> {
  const filePath = manifestFilePath(rootDir, manifest.version);
  // Manifests record provider coordinates (host, user, path) for every shard.
  // Keep them owner-only on POSIX: mode applies on create, chmod restricts an
  // already-existing inode; both are a no-op on Windows NTFS (ACL-based).
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

/**
 * Lists all version manifests found in .bfs/manifests/, sorted ascending by version.
 * Silently skips unreadable or malformed manifest files.
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
    try {
      const content = await fs.readFile(path.join(dir, entry), 'utf-8');
      manifests.push(JSON.parse(content) as VersionManifest);
    } catch {
      // skip unreadable / malformed manifests
    }
  }
  return manifests.sort((a, b) => a.version - b.version);
}

/**
 * Deletes the manifest file for the given version.
 * @throws on unlink failure (including ENOENT).
 */
export async function deleteManifest(rootDir: string, version: number): Promise<void> {
  await fs.unlink(manifestFilePath(rootDir, version));
}

/**
 * Records a health change that comes from altering the stored data itself — a
 * rebuilt shard, a removed provider — rather than from a verify pass.
 *
 * Verify provenance (`health_deep_rot`, `health_checked_at`) is cleared, because
 * it describes a check performed against the previous state of the media: keeping
 * it would let a stale "payload rot was read off the media" claim outlive the
 * repair that fixed it. The next verify re-establishes both.
 *
 * @param manifest - Manifest to update in place
 * @param health   - Health the caller determined from the change it just made
 * @returns the same manifest, for use in a write call
 */
export function applyHealthChange(manifest: VersionManifest, health: VersionHealth): VersionManifest {
  manifest.health = health;
  delete manifest.health_deep_rot;
  delete manifest.health_checked_at;
  return manifest;
}
