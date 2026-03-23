import { readFileSync } from 'node:fs';
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
