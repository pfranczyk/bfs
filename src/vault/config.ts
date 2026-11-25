import fs from 'node:fs/promises';
import path from 'node:path';
import { BfsError, VaultAlreadyInitializedError } from '../core/errors.js';
import { isEnoent, writeJsonAtomic } from '../core/fs-utils.js';
import { fmt, t } from '../i18n/index.js';
import type { VaultConfig } from '../types/index.js';
import { MANIFEST_FILENAME } from './manifest.js';
import { readState } from './state.js';

/**
 * Smallest pool any valid scheme fits: at least 2 data parts and 1 parity part.
 * Below it no backup can be made or restored from the configuration.
 */
export const MIN_PROVIDERS = 3;

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
 * Writes VaultConfig to .bfs/config.json (pretty-printed JSON), replacing the
 * file in one step so an interrupted write leaves the previous configuration
 * in place, and restricted to owner-only permissions because it holds provider
 * connection secrets (POSIX; Windows NTFS ignores the mode bits).
 * @throws on write failure.
 */
export async function writeConfig(rootDir: string, config: VaultConfig): Promise<void> {
  await writeJsonAtomic(path.join(rootDir, '.bfs', 'config.json'), config);
}

/**
 * Extracts the backup name from raw config bytes, or null when the content does
 * not yield one. Every way of failing collapses to "name unavailable" rather
 * than propagating a parser error - the callers decide from it whether the file
 * describes a backup at all.
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

/** What `init` may do in a working directory (see {@link inspectInitTarget}). */
export type InitTarget = { kind: 'new' } | { kind: 'resume'; config: VaultConfig };

/**
 * Tells whether the working directory has any version file in
 * `.bfs/manifests` - `v000.json` included, since a backup written as version 0
 * exists all the same. A missing directory means no versions.
 *
 * @param rootDir - Vault root directory to inspect
 * @returns true when at least one `vNNN.json` is present
 * @throws on a directory read error other than ENOENT
 */
async function hasManifestFiles(rootDir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(path.join(rootDir, '.bfs', 'manifests'));
    return entries.some((e) => MANIFEST_FILENAME.test(e));
  } catch (err: unknown) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * Tells whether the backup in the working directory has a version: a
 * `latest_version` above 0 or any version file on disk. One definition for the
 * `init` gate and for the refusal other commands give on a short pool, so the
 * two never disagree about the same directory.
 *
 * @param rootDir - Vault root directory to inspect
 * @returns true when a version is recorded
 * @throws on a state or directory read error other than ENOENT
 */
export async function hasRecordedVersion(rootDir: string): Promise<boolean> {
  if ((await readState(rootDir)).latest_version > 0) return true;
  return hasManifestFiles(rootDir);
}

/**
 * Parses config bytes into a configuration `init` can resume from, or null when
 * the content does not describe one (truncated, `null`, no name, no pool or
 * scheme). Every way of failing collapses to null - the caller reports the
 * file as unreadable rather than a parser error.
 */
function _resumableConfigIn(content: string): Nullable<VaultConfig> {
  if (_vaultNameIn(content) === null) return null;
  const parsed = JSON.parse(content) as Partial<VaultConfig>;
  const scheme = parsed.scheme;
  if (!Array.isArray(parsed.providers) || scheme === null || typeof scheme !== 'object') return null;
  if (!Number.isInteger(scheme.data_shards) || !Number.isInteger(scheme.parity_shards)) return null;
  return parsed as VaultConfig;
}

/**
 * Decides what `init` may do in the working directory, before any medium is
 * touched. `init` writes `config.json` after the first storage passes its probe
 * and rewrites it after each later one, so an interrupted run leaves a
 * configuration short of its storages - which the next run resumes:
 * - no configuration and no version files -> a new backup (`.bfs/` alone, or
 *   `.bfs/manifests` alone, is left by every interrupted run and says nothing);
 * - a readable configuration short of N+K storages, with no version -> resume;
 * - a full pool, or a short one with a version (e.g. after
 *   `provider remove --strategy remove` on a backup that was pushed) ->
 *   refusal naming the backup;
 * - version files without a configuration, or a configuration that cannot be
 *   read -> refusal naming that state, without suggesting a command: whether
 *   the operator wants that backup back or a new one here is not something BFS
 *   can tell.
 *
 * A configuration is recognised by the FILE, not by what parses out of it: a file
 * whose whole content is `null` must not pass for a missing one, or a live
 * backup's record would be overwritten.
 *
 * @param rootDir - Vault root directory to inspect
 * @returns `new`, or `resume` with the recorded configuration
 * @throws VaultAlreadyInitializedError when the directory cannot take an init
 * @throws BfsError when the file cannot be read at all, so its presence is undecided
 * @throws the raw error of a state or manifest directory read that fails other than ENOENT
 */
export async function inspectInitTarget(rootDir: string): Promise<InitTarget> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      // A permission wall, a directory in place of the file, a lock a concurrent
      // run is holding: that says nothing about whether a backup is here, so the
      // refusal names the read error and claims nothing about the file.
      const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
      throw new BfsError(fmt('init_vault_check_failed', reason));
    }
    if (await hasManifestFiles(rootDir)) throw new VaultAlreadyInitializedError(t('init_vault_versions_without_config'));
    return { kind: 'new' };
  }
  const config = _resumableConfigIn(content);
  if (config === null) {
    const key = (await hasManifestFiles(rootDir)) ? 'init_vault_exists_unreadable_versions' : 'init_vault_exists_unreadable';
    throw new VaultAlreadyInitializedError(t(key));
  }
  const required = config.scheme.data_shards + config.scheme.parity_shards;
  if (config.providers.length >= required || (await hasRecordedVersion(rootDir))) {
    throw new VaultAlreadyInitializedError(fmt('init_vault_exists', config.vault_name));
  }
  return { kind: 'resume', config };
}

/**
 * Aborts when the working directory already describes a backup, so `recovery`
 * never replaces a live configuration. Rebuilding over one swaps the provider
 * settings for those of whichever backup was recovered and leaves the previous
 * manifests behind as orphans, cutting the directory off from versions it still
 * lists - and it does so before the operator sees a single result.
 *
 * What counts as a backup is a file yielding a backup name. The difference from
 * the `init` gate (`inspectInitTarget`) is deliberate. `init` keys on the FILE,
 * because a directory it cannot read is still someone's; recovery is the
 * command that rebuilds an unreadable one, so
 * an empty, truncated or nameless file has to let it through - that is what
 * keeps a failed recovery repeatable.
 *
 * A read that fails outright is neither: it says nothing about whether a backup
 * is here, and starting over during a momentary lock would destroy a live one.
 *
 * @param rootDir - Vault root directory to inspect
 * @throws VaultAlreadyInitializedError when .bfs/config.json names a backup
 * @throws BfsError when the file cannot be read at all, so its presence is undecided
 */
export async function assertRecoveryTargetFree(rootDir: string): Promise<void> {
  const filePath = path.join(rootDir, '.bfs', 'config.json');
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    const reason = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    throw new BfsError(fmt('recovery_vault_check_failed', reason));
  }
  const name = _vaultNameIn(content);
  if (name !== null) throw new VaultAlreadyInitializedError(fmt('recovery_vault_exists', name));
}

/**
 * Validates scheme + providers in the loaded config. Fails fast with a
 * user-level message before any provider work starts, instead of letting
 * lower layers throw cryptic internal errors.
 *
 * A pool short of its scheme with no version yet is an `init` that has not
 * finished; `noVersionYet` adds that state to the refusal (the caller knows it,
 * see `hasRecordedVersion`) without suggesting which way out to take.
 *
 * @param config - The loaded configuration
 * @param opts   - `noVersionYet`: the backup has no version recorded
 * @throws BfsError if scheme is missing or corrupted, or providers count does
 *         not equal data_shards + parity_shards.
 */
export function assertSchemeValid(config: VaultConfig, opts: { noVersionYet?: boolean } = {}): void {
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
    const mismatch = fmt(schemeMismatchKey(config.providers.length, required), String(required), String(config.providers.length));
    const short = config.providers.length < required;
    throw new BfsError(short && opts.noVersionYet === true ? `${mismatch} ${t('scheme_no_version_yet')}` : mismatch);
  }
}

/**
 * `assertSchemeValid` for a command about to make or restore a backup: when the
 * pool is short of its scheme, whether the backup has a version yet is read from
 * disk and named in the refusal. A valid pool costs no extra read.
 *
 * @param rootDir - Vault root directory
 * @param config  - The loaded configuration
 * @throws BfsError as `assertSchemeValid` does
 * @throws on a state or manifest directory read error while checking a short pool
 */
export async function assertSchemeReady(rootDir: string, config: VaultConfig): Promise<void> {
  const scheme = config.scheme;
  const short = scheme !== null && scheme !== undefined && config.providers.length < scheme.data_shards + scheme.parity_shards;
  assertSchemeValid(config, { noVersionYet: short && !(await hasRecordedVersion(rootDir)) });
}

/**
 * Picks the message for a pool that does not match its scheme, by which side
 * is larger. A short pool has two ways out - a new storage takes the missing
 * place, or the scheme is matched to the storages left - except below the
 * smallest valid pool, where no scheme fits and only a new storage helps. A
 * pool larger than its scheme is what a rebuild onto a new storage leaves when
 * it stops halfway (the new entry is written first, the old one goes last);
 * `bfs scheme set` with the larger sum would be accepted there and count the
 * free entry as a place holding a part, so the message names the state and
 * the rebuild that finishes it instead.
 *
 * @param providerCount - Storages in the configuration
 * @param required      - Storages the scheme uses (N + K)
 * @returns The i18n key for the refusal
 */
function schemeMismatchKey(providerCount: number, required: number): 'scheme_providers_below_minimum' | 'scheme_providers_short' | 'scheme_providers_surplus' {
  if (providerCount < MIN_PROVIDERS) return 'scheme_providers_below_minimum';
  return providerCount < required ? 'scheme_providers_short' : 'scheme_providers_surplus';
}
