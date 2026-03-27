import fs from 'node:fs/promises';
import path from 'node:path';
import { isEnoent } from '../core/fs-utils.js';
import type { VaultConfig } from '../types/index.js';

/**
 * Reads .bfs/config.json from the given vault root directory.
 * @returns VaultConfig or null if the file does not exist.
 * @throws on read/parse errors other than ENOENT.
 */
export async function readConfig(
  rootDir: string,
): Promise<Nullable<VaultConfig>> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as VaultConfig;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Writes VaultConfig to .bfs/config.json (pretty-printed JSON).
 * The .bfs directory must already exist.
 * @throws on write failure.
 */
export async function writeConfig(
  rootDir: string,
  config: VaultConfig,
): Promise<void> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
}
