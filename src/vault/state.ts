import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnoent } from '../core/fs-utils.js';
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
 * Writes VaultState to .bfs/state.json (pretty-printed JSON).
 * The .bfs directory must already exist.
 * @throws on write failure.
 */
export async function writeState(rootDir: string, state: VaultState): Promise<void> {
  const filePath = path.join(rootDir, '.bfs', 'state.json');
  // state.json sits in .bfs/ next to config.json; keep it owner-only on POSIX
  // for defense-in-depth. mode applies on create, chmod restricts an
  // already-existing inode; both are a no-op on Windows NTFS (ACL-based).
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}
