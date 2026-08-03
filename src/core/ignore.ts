import { readFileSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import type { IgnoreFilter } from '../types/index.js';

/**
 * Creates an IgnoreFilter from the .bfsignore file in rootDir (gitignore format).
 * Always ignores the .bfs/ directory. If .bfsignore does not exist, only .bfs/ is excluded.
 */
export function createIgnoreFilter(rootDir: string): IgnoreFilter {
  const ig = ignore();
  ig.add('.bfs/');

  try {
    const content = readFileSync(join(rootDir, '.bfsignore'), 'utf-8');
    ig.add(content);
  } catch {
    // .bfsignore does not exist — skip
  }

  return (relativePath: string) => ig.ignores(relativePath);
}

/**
 * Converts a relative path into a gitignore pattern matching that path, anchored
 * to the root with a leading slash and escaping gitignore metacharacters (`\`,
 * `#`, `!`, `[`, `]`, `*`, `?`) so a literal name is not read as a comment,
 * negation, or glob. Names with trailing whitespace or an embedded newline
 * cannot be represented as a matching pattern here; the caller detects a name
 * that stays unmatched with a progress guard rather than relying on this
 * function to encode every possible name.
 */
function toBfsignorePattern(relPath: string): string {
  // Escape backslash and the metacharacters in one pass (the class includes `\`,
  // so a literal backslash in the name is doubled).
  const escaped = relPath.replace(/[\\#![\]*?]/g, '\\$&');
  return `/${escaped}`;
}

/**
 * Appends the given relative paths to the .bfsignore in rootDir as anchored,
 * escaped patterns so a later scan excludes them. Creates the file if missing.
 * Used by the interactive push gate when the user opts to ignore entries that
 * cannot be backed up (symlinks / special files) and retry.
 *
 * @param rootDir - Backup working directory holding .bfsignore
 * @param paths   - Relative paths (forward slashes) to exclude from now on
 */
export async function appendToBfsignore(rootDir: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const bfsignorePath = join(rootDir, '.bfsignore');
  let existing = '';
  try {
    existing = await readFile(bfsignorePath, 'utf-8');
  } catch {
    // .bfsignore does not exist yet — appendFile creates it.
  }
  const leadingNl = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const patterns = paths.map(toBfsignorePattern).join('\n');
  await appendFile(bfsignorePath, `${leadingNl}# entries that cannot be backed up (added by bfs push)\n${patterns}\n`, 'utf-8');
}
