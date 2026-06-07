import fs from 'node:fs/promises';
import path from 'node:path';
import { BfsError } from '../core/errors.js';
import { isEnoent } from '../core/fs-utils.js';
import { fmt, t } from '../i18n/index.js';
import type { VaultConfig } from '../types/index.js';

/**
 * Reads .bfs/config.json from the given vault root directory.
 * @returns VaultConfig or null if the file does not exist.
 * @throws on read/parse errors other than ENOENT.
 */
export async function readConfig(rootDir: string): Promise<Nullable<VaultConfig>> {
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
 * Writes VaultConfig to .bfs/config.json (pretty-printed JSON), restricted to
 * owner-only permissions because it holds provider connection secrets.
 * The .bfs directory must already exist.
 * @throws on write failure.
 */
export async function writeConfig(rootDir: string, config: VaultConfig): Promise<void> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  // config.json holds provider connection secrets (e.g. FTP password), so keep
  // it readable only by the owner. writeFile's mode applies when the file is
  // created; chmod also covers overwriting an existing inode. POSIX enforces
  // 0600; Windows NTFS ignores POSIX mode bits, so chmod is a best-effort no-op.
  await fs.writeFile(filePath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

/**
 * Validates scheme + providers in the loaded config. Called by commands that
 * interact with providers (push/pull/verify/prune/heal/provider-remove) to
 * fail fast with a user-level message before any provider work starts —
 * instead of letting lower layers throw cryptic internal errors.
 *
 * @throws BfsError if scheme is missing or corrupted, or providers count does
 *         not equal data_shards + parity_shards.
 */
export function assertSchemeValid(config: VaultConfig): void {
  const scheme = config.scheme;
  if (scheme === null || scheme === undefined) {
    throw new BfsError(t('scheme_missing'));
  }
  const { data_shards, parity_shards } = scheme;
  if (!Number.isInteger(data_shards) || (data_shards as number) < 2) {
    throw new BfsError(fmt('scheme_invalid_data_shards', String(data_shards)));
  }
  if (!Number.isInteger(parity_shards) || (parity_shards as number) < 1) {
    throw new BfsError(fmt('scheme_invalid_parity_shards', String(parity_shards)));
  }
  const required = data_shards + parity_shards;
  if (config.providers.length !== required) {
    throw new BfsError(fmt('scheme_providers_mismatch', String(required), String(config.providers.length)));
  }
}
