import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnoent, writeJsonAtomic } from '../core/fs-utils.js';
import type { VaultState } from '../types/index.js';

/** Default vault state when no state.json exists yet. */
export const DEFAULT_STATE: VaultState = { latest_version: 0, working_version: 0 };

/**
 * Reads .bfs/state.json; returns the default state (all zeros) if not found.
 * @throws on read/parse errors other than ENOENT.
 */
export async function readState(rootDir: string): Promise<VaultState> {
  const filePath = path.join(rootDir, '.bfs', 'state.json');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as VaultState;
  } catch (err: unknown) {
    if (isEnoent(err)) return { ...DEFAULT_STATE };
    throw err;
  }
}

/**
 * Writes VaultState to .bfs/state.json (pretty-printed JSON), replacing the
 * file in one step so an interrupted write leaves the previous state in place -
 * push numbers the next version from latest_version, so a torn file would
 * lose it. Owner-only on POSIX for defense-in-depth, next to config.json.
 * @throws on write failure.
 */
export async function writeState(rootDir: string, state: VaultState): Promise<void> {
  await writeJsonAtomic(path.join(rootDir, '.bfs', 'state.json'), state);
}
