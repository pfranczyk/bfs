/**
 * Catalog drift verification — detects whether a packed blob still matches the
 * source directory 1:1 (currency), independent of single-read internal
 * consistency (recoverability).
 *
 * A push brackets the pack window with two `stat` snapshots (before pack and
 * after pack) and diffs them. Any file whose size or mtime changed, that
 * vanished, or that appeared during packing is reported as drift. This is
 * format-independent (works for compressed and raw blobs alike) because it
 * never inspects the blob's file table.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { scanDir } from '../core/blob-pack.js';
import type { CatalogDrift, CatalogSnapshot, IgnoreFilter } from '../types/index.js';

/**
 * Captures the current size + mtime of every non-ignored file under rootDir.
 * Uses the same scan + ignore logic as packing, so the file set matches the
 * blob's. A file that cannot be stat'd (vanished/unreadable) is omitted — the
 * diff then surfaces it as vanished/appeared naturally.
 *
 * @param rootDir      - Directory to snapshot
 * @param ignoreFilter - Filter: returns true = ignore the relative path
 * @returns Map of relative path (forward-slash) → { size, mtimeMs }
 */
export async function snapshotCatalog(rootDir: string, ignoreFilter: IgnoreFilter): Promise<CatalogSnapshot> {
  const metas = await scanDir(rootDir, ignoreFilter);
  const snapshot: CatalogSnapshot = new Map();
  for (const meta of metas) {
    try {
      const stat = await fs.stat(path.join(rootDir, meta.relativePath));
      snapshot.set(meta.relativePath, { size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
    } catch {
      // Unreadable/vanished between scan and stat — omit; diff reports it.
    }
  }
  return snapshot;
}

/**
 * Diffs two catalog snapshots bracketing the pack window.
 * A path in `exclude` (e.g. files skipped during packing) is omitted from every
 * bucket so it is not double-reported.
 *
 * @param before  - Snapshot taken before packing
 * @param after   - Snapshot taken after packing
 * @param exclude - Paths to omit from the diff (default none)
 * @returns Files that changed, vanished, or appeared during the window
 */
export function diffCatalog(before: CatalogSnapshot, after: CatalogSnapshot, exclude: ReadonlySet<string> = new Set()): CatalogDrift {
  const changed: string[] = [];
  const vanished: string[] = [];
  const appeared: string[] = [];
  for (const [rel, b] of before) {
    if (exclude.has(rel)) continue;
    const a = after.get(rel);
    if (a === undefined) {
      vanished.push(rel);
    } else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
      changed.push(rel);
    }
  }
  for (const rel of after.keys()) {
    if (exclude.has(rel)) continue;
    if (!before.has(rel)) appeared.push(rel);
  }
  return { changed, vanished, appeared };
}

/**
 * Reports whether a drift result contains any divergence.
 *
 * @param drift - Result from diffCatalog
 * @returns true when any of changed/vanished/appeared is non-empty
 */
export function catalogHasDrift(drift: CatalogDrift): boolean {
  return drift.changed.length > 0 || drift.vanished.length > 0 || drift.appeared.length > 0;
}
