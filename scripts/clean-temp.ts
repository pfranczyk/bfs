/**
 * Removes the temporary directories that test runs and the smoke harness leave
 * behind in the system temp directory.
 *
 * Reporting is the default and deleting needs `--force`, because the flags have
 * to survive `npm run`: npm treats `--dry-run` as one of its own settings and
 * swallows it, so `npm run clean:temp --dry-run` would reach this script with an
 * empty argv. Safe-by-default makes that mistake harmless; passing flags through
 * at all needs the `--` separator.
 *
 * Usage:
 *   npm run clean:temp                    # report what would go, delete nothing
 *   npm run clean:temp -- --force         # delete
 *   npm run clean:temp -- --min-age 0 --force   # delete regardless of age
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Every temp directory this project creates is named `bfs-...` - suites, unit
 * tests and the smoke harness alike - so this one prefix covers the whole
 * namespace. It is not exclusive to scratch data: a push configured with
 * `temp_dir` pointing at the system temp writes `bfs-parity-*.tmp` files there,
 * which is why only directories are ever considered.
 */
const PREFIX = 'bfs-';

/**
 * How long a directory must sit untouched before it counts as abandoned. A run
 * in progress owns directories it is still writing to, so recent ones are left
 * alone. The guard reads the mtime of the top-level directory, which a write
 * deep inside does not refresh - it is a safety margin, not a lock.
 */
const DEFAULT_MIN_AGE_MINUTES = 60;

const USAGE = [
  'Usage: npm run clean:temp [-- --force] [-- --min-age <minutes>]',
  '',
  '  (no flags)          report what would be removed, delete nothing',
  '  --force             actually delete',
  '  --min-age <minutes> how long a directory must be untouched (default 60)',
].join('\n');

interface Options {
  force: boolean;
  minAgeMs: number;
}

interface Candidate {
  name: string;
  fullPath: string;
  ageMs: number;
}

/**
 * Reads `--force` and `--min-age <minutes>` off argv. Anything else is refused
 * rather than ignored: a typo in a flag must not silently select the deleting
 * path.
 *
 * @param argv - Arguments after the script name
 * @returns      Parsed options
 * @throws Error on an unknown flag or an unusable --min-age value
 */
function parseArgs(argv: string[]): Options {
  let force = false;
  let minutes = DEFAULT_MIN_AGE_MINUTES;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--min-age') {
      i++;
      const raw = argv[i];
      minutes = raw === undefined ? Number.NaN : Number(raw);
      if (!Number.isFinite(minutes) || minutes < 0) {
        throw new Error(`--min-age needs a non-negative number of minutes, got: ${raw ?? '(nothing)'}`);
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg ?? ''}`);
  }
  return { force, minAgeMs: minutes * 60_000 };
}

/**
 * Lists the project's leftover directories directly under the system temp
 * directory. Entries that vanish between listing and stat are skipped - a
 * concurrent run may be cleaning up after itself.
 *
 * @param base - Directory to scan (never descended into beyond one level)
 * @param now  - Reference timestamp for the age of each entry
 * @returns      One entry per matching directory
 */
async function collectCandidates(base: string, now: number): Promise<Candidate[]> {
  const entries = await fs.readdir(base, { withFileTypes: true });
  const found: Candidate[] = [];

  for (const entry of entries) {
    // isDirectory() is false for a junction or symlink, so a link planted under
    // this prefix is never followed and never removed.
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const fullPath = path.join(base, entry.name);
    try {
      const info = await fs.stat(fullPath);
      found.push({ name: entry.name, fullPath, ageMs: now - info.mtimeMs });
    } catch {
      // gone already, or unreadable - nothing to clean either way
    }
  }
  return found;
}

/**
 * Collapses `bfs-ssh-cfg-A1b2C3` / `bfs-smoke-1786571917875` to the family they
 * belong to, so the summary names what accumulated instead of printing thousands
 * of unique directory names.
 *
 * @param name - Directory name
 * @returns      Name without its trailing unique segment
 */
function family(name: string): string {
  const cut = name.lastIndexOf('-');
  return cut <= 0 ? name : name.slice(0, cut);
}

/**
 * Prints how many directories each family contributes, largest first.
 *
 * @param candidates - Directories to summarize
 */
function reportFamilies(candidates: Candidate[]): void {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    counts.set(family(c.name), (counts.get(family(c.name)) ?? 0) + 1);
  }
  for (const [name, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${name}-*`);
  }
}

/**
 * Deletes one directory, clearing its mode and retrying once when the first
 * attempt is refused - tests deliberately leave read-only directories behind,
 * and on POSIX those block the unlink until the mode is relaxed.
 *
 * @param target - Absolute path to remove
 * @throws whatever the second attempt throws
 */
async function removeDir(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    await fs.chmod(target, 0o700);
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Removes every candidate, collecting failures instead of stopping at the first.
 *
 * @param stale - Directories judged abandoned
 * @returns       Count removed plus one message per failure
 */
async function removeAll(stale: Candidate[]): Promise<{ removed: number; failed: string[] }> {
  let removed = 0;
  const failed: string[] = [];

  for (const c of stale) {
    try {
      await removeDir(c.fullPath);
      removed++;
    } catch (err: unknown) {
      failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { removed, failed };
}

/** Prints the failures, capped, saying how many were left unprinted. */
function reportFailures(failed: string[]): void {
  const shown = failed.slice(0, 10);
  for (const line of shown) console.log(`  ! ${line}`);
  if (failed.length > shown.length) console.log(`  ! ...and ${failed.length - shown.length} more`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const base = os.tmpdir();
  const candidates = await collectCandidates(base, Date.now());
  const stale = candidates.filter((c) => c.ageMs >= options.minAgeMs);
  const recent = candidates.length - stale.length;

  console.log(`[CLEAN-TEMP] base: ${base}`);
  if (stale.length === 0) {
    console.log(`[CLEAN-TEMP] nothing to remove (${recent} kept as too recent)`);
    return;
  }

  reportFamilies(stale);
  if (!options.force) {
    console.log(`[CLEAN-TEMP] ${stale.length} would be removed, ${recent} kept as too recent`);
    console.log('[CLEAN-TEMP] nothing deleted - rerun with `npm run clean:temp -- --force`');
    return;
  }

  const { removed, failed } = await removeAll(stale);
  console.log(`[CLEAN-TEMP] removed ${removed}, kept ${recent} as too recent, failed ${failed.length}`);
  reportFailures(failed);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[CLEAN-TEMP]', err instanceof Error ? err.message : String(err));
  console.error(USAGE);
  process.exit(2);
});
