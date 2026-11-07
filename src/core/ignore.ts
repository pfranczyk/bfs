import { type BigIntStats, lstatSync, readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import type { IgnoreFilter } from '../types/index.js';

const BFSIGNORE_NAME = '.bfsignore';

/**
 * Creates an IgnoreFilter from the .bfsignore file in rootDir (gitignore format).
 * Always ignores the .bfs/ directory. If .bfsignore does not exist, only .bfs/ is excluded.
 * Letter case is matched the way git sets `core.ignorecase`: by what the backup
 * directory's filesystem does, not by the operating system - so on a
 * case-sensitive directory `/Readme` leaves a file `README` in the backup.
 *
 * @param rootDir - Backup working directory holding .bfsignore
 * @returns Predicate: true when a relative path is excluded from the backup
 */
export function createIgnoreFilter(rootDir: string): IgnoreFilter {
  let content: Nullable<string> = null;
  try {
    content = readFileSync(join(rootDir, BFSIGNORE_NAME), 'utf-8');
  } catch {
    // .bfsignore does not exist - only .bfs/ is excluded
  }

  const ig = ignore({ ignorecase: _directoryIgnoresCase(rootDir) });
  ig.add('.bfs/');
  if (content !== null) ig.add(content);

  return (relativePath: string) => ig.ignores(relativePath);
}

/**
 * Tells whether a relative path can be written as a single .bfsignore line that
 * matches exactly that path. A line feed cannot be written into a line at all; a
 * carriage return could survive only inside a bracket, which an editor or a
 * line-ending conversion turns into a line break - so both are refused.
 *
 * @param relPath - Relative path (forward slashes)
 * @returns true when appendToBfsignore can write a pattern for it
 */
export function isBfsignoreWritable(relPath: string): boolean {
  return !/[\r\n]/.test(relPath);
}

/**
 * Converts a relative path into a gitignore pattern matching that path, anchored
 * to the root with a leading slash and escaping gitignore metacharacters (`\`,
 * `#`, `!`, `[`, `]`, `*`, `?`) so a literal name is not read as a comment,
 * negation, or glob. Trailing spaces are escaped one by one, because a
 * gitignore line drops unescaped trailing spaces and would then match the name
 * without them.
 */
function toBfsignorePattern(relPath: string): string {
  // Escape backslash and the metacharacters in one pass (the class includes `\`,
  // so a literal backslash in the name is doubled).
  const escaped = relPath.replace(/[\\#![\]*?]/g, '\\$&');
  const trailing = /( +)$/.exec(escaped)?.[1] ?? '';
  const body = escaped.slice(0, escaped.length - trailing.length);
  return `/${body}${'\\ '.repeat(trailing.length)}`;
}

/**
 * Appends the given relative paths to the .bfsignore in rootDir as anchored,
 * escaped patterns so a later scan excludes them. Creates the file if missing.
 * Used by the interactive push gate when the user opts to ignore entries that
 * cannot be backed up (symlinks / special files) and retry.
 *
 * @param rootDir - Backup working directory holding .bfsignore
 * @param paths   - Relative paths (forward slashes) to exclude from now on
 * @throws Error when a path fails isBfsignoreWritable - nothing is written then,
 *         since a partial line would later exclude a different file
 */
export async function appendToBfsignore(rootDir: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const unwritable = paths.find((p) => !isBfsignoreWritable(p));
  if (unwritable !== undefined) throw new Error(`cannot write a .bfsignore pattern for ${JSON.stringify(unwritable)}`);
  const bfsignorePath = join(rootDir, BFSIGNORE_NAME);
  let existing = '';
  try {
    existing = await readFile(bfsignorePath, 'utf-8');
  } catch {
    // .bfsignore does not exist yet - appendFile creates it.
  }
  const leadingNl = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const patterns = paths.map(toBfsignorePattern).join('\n');
  await appendFile(bfsignorePath, `${leadingNl}# entries that cannot be backed up (added by bfs push)\n${patterns}\n`, 'utf-8');
}

/**
 * Probes, without writing anything, whether the backup directory resolves names
 * regardless of letter case: the upper-cased name of an entry BFS keeps there
 * (.bfsignore, else .bfs) must lead to the very same entry. With neither present
 * there is nothing to probe and the only pattern is `.bfs/`, so case is ignored.
 */
function _directoryIgnoresCase(rootDir: string): boolean {
  for (const name of [BFSIGNORE_NAME, '.bfs']) {
    let actual: BigIntStats;
    try {
      actual = lstatSync(join(rootDir, name), { bigint: true });
    } catch {
      continue; // this entry is absent - try the next one
    }
    try {
      const swapped = lstatSync(join(rootDir, name.toUpperCase()), { bigint: true });
      return actual.ino === swapped.ino && actual.dev === swapped.dev;
    } catch {
      // The upper-cased name does not resolve (or cannot be read): match case
      // exactly, which keeps every entry the push gate writes exact.
      return false;
    }
  }
  return true;
}
