import fs from 'node:fs/promises';
import path from 'node:path';
import { BfsError, VaultAlreadyInitializedError } from '../core/errors.js';
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
 * Extracts the backup name from raw config bytes, or null when the content does
 * not yield one. Used only to make a refusal concrete, so every way of failing
 * collapses to "name unavailable" rather than propagating a parser error.
 */
function _vaultNameIn(content: string): Nullable<string> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed === null || typeof parsed !== 'object') return null;
    const name = (parsed as { vault_name?: unknown }).vault_name;
    return typeof name === 'string' && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/**
 * Aborts when the working directory already describes a backup, so `init` never
 * replaces a live configuration. Overwriting one mints a fresh vault_id and
 * resets the version history while the shards on the media keep the old id - the
 * directory stops reaching data it holds versions for - and it discards the only
 * stored copy of the provider secrets.
 *
 * Keyed on the presence of the FILE, not on what parses out of it. Reading it
 * back through `readConfig` would split one state into two wrong answers: a file
 * whose whole content is `null` yields the same `null` as a file that is not
 * there, and a file that is merely truncated raises a parser error. The first
 * would overwrite a live backup's record, the second would reach the operator as
 * a bare `SyntaxError`. The name is read purely to make the refusal concrete;
 * when it is unavailable the message changes, the guard does not.
 *
 * `.bfs/` alone is deliberately not evidence. `init` creates it before
 * contacting any medium and writes the configuration only afterwards, so every
 * init that fails in between leaves the directory behind - and no command
 * removes it, so refusing on that would leave the operator no way back.
 *
 * @param rootDir - Vault root directory to inspect
 * @throws VaultAlreadyInitializedError when .bfs/config.json is present
 * @throws BfsError when the file cannot be read at all, so its presence is undecided
 */
export async function assertNoExistingVault(rootDir: string): Promise<void> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    // The read failed for some other reason - a permission wall, a directory in
    // place of the file, a lock a concurrent run is holding. That says nothing
    // about whether a backup is here, so the refusal must not claim the
    // configuration is damaged: the advice that follows from damage is "delete
    // it", and following that during a momentary lock would destroy a live one.
    // Name the read error instead and leave the operator to settle it.
    const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new BfsError(fmt('init_vault_check_failed', reason));
  }
  const name = _vaultNameIn(content);
  if (name === null) throw new VaultAlreadyInitializedError(t('init_vault_exists_unreadable'));
  throw new VaultAlreadyInitializedError(fmt('init_vault_exists', name));
}

/**
 * Validates scheme + providers in the loaded config. Fails fast with a
 * user-level message before any provider work starts, instead of letting
 * lower layers throw cryptic internal errors.
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
