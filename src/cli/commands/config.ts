import path from 'node:path';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import type { PushMode, VaultConfig } from '../../types/index.js';
import { isZeroRamBudget, readConfig, writeConfig } from '../../vault/config.js';
import { validateConfigDir } from '../../vault/scratch-dir.js';
import { resolveCwd } from '../cwd.js';
import { parseMaxRamFlag } from '../parse-max-ram.js';
import { parsePushModeFlag } from '../parse-push-mode.js';
import { CommandAbort, error, info, success } from '../ui.js';

type Feature = 'compression' | 'encryption';

/** One line of `bfs config` output, in the order they are printed. */
type SettingKey = 'cache-dir' | 'temp-dir' | 'max-ram' | 'push-mode' | Feature;

const SETTING_ORDER: readonly SettingKey[] = ['cache-dir', 'temp-dir', 'max-ram', 'push-mode', 'compression', 'encryption'];

const FEATURE_MAP: Readonly<Record<string, Feature>> = { compress: 'compression', compression: 'compression', encryption: 'encryption', encrypt: 'encryption' };

interface ConfigOpts {
  cacheDir?: string | true;
  tempDir?: string | true;
  maxRam?: string | true;
  pushMode?: string;
  reset?: boolean;
  on?: string[];
  off?: string[];
}

/** Everything the command will write, settled before config.json is touched. */
interface ConfigChanges {
  readonly cacheDir: Nullable<string> | undefined;
  readonly tempDir: Nullable<string> | undefined;
  readonly maxRam: Nullable<number> | undefined;
  readonly pushMode: PushMode | undefined;
  readonly features: ReadonlyMap<Feature, boolean>;
}

/**
 * Checks a directory setting the way push and pull check it before use, so the
 * only writer of `cache_dir` / `temp_dir` cannot store a value its own readers
 * refuse. A leaf that does not exist yet is accepted - push and pull create it.
 *
 * @param dir - Path given on the command line
 * @param flag - Which setting is being written (`cache-dir` / `temp-dir`)
 * @throws CommandAbort after printing why the path was refused and how to fix it
 */
async function assertUsableDir(dir: string, flag: 'cache-dir' | 'temp-dir'): Promise<void> {
  try {
    await validateConfigDir(path.resolve(dir), flag);
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : String(err));
    throw new CommandAbort();
  }
}

/**
 * Registers the `bfs config` command on the given Commander program.
 *
 * Without arguments: displays current settings (cache/temp/ram/push-mode + compression/encryption).
 * With --cache-dir/--temp-dir/--max-ram/--push-mode and --on/--off <feature>
 * (each of the last two may be repeated): applies every setting given, in one
 * write, and lists what was set. Every value is checked first, so one refused
 * value (unknown mode or feature, unusable directory, a RAM limit that is not a
 * whole number above zero, a feature named by both
 * --on and --off) refuses the whole command and leaves config.json untouched.
 * With --reset: resets the cache/temp/ram settings given next to it. --reset has
 * nothing to bring push-mode or a feature back to, so those are simply applied.
 *
 * @param program - Commander program to attach the command to
 */
export function registerConfig(program: Command): void {
  const collect = (value: string, previous: string[] = []): string[] => [...previous, value];
  program
    .command('config')
    .description(t('cmd_config_desc'))
    .option('--cache-dir [path]', t('config_opt_cache_dir'))
    .option('--temp-dir [path]', t('config_opt_temp_dir'))
    .option('--max-ram [mb]', t('config_opt_max_ram'))
    .option('--push-mode <mode>', t('config_opt_push_mode'))
    .option('--reset', t('config_opt_reset'))
    .option('--on <feature>', t('config_opt_on'), collect)
    .option('--off <feature>', t('config_opt_off'), collect)
    .action(async (opts: ConfigOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        return;
      }
      await _runConfig(rootDir, config, opts);
    });
}

/** Shows the settings, or validates and applies the ones given. */
async function _runConfig(rootDir: string, config: VaultConfig, opts: ConfigOpts): Promise<void> {
  const hasFeature = (opts.on?.length ?? 0) > 0 || (opts.off?.length ?? 0) > 0;
  const hasResettable = opts.cacheDir !== undefined || opts.tempDir !== undefined || opts.maxRam !== undefined;
  if (opts.reset === true && !hasResettable && opts.pushMode === undefined && !hasFeature) {
    error(t('config_reset_no_field'));
    return;
  }
  if (!hasResettable && opts.pushMode === undefined && !hasFeature) {
    _printSettings(rootDir, config);
    return;
  }

  const changes = await _resolveChanges(opts);
  const changed = _applyChanges(config, changes);
  await writeConfig(rootDir, config);

  success(t('config_updated'));
  const lines = _settingLines(rootDir, config);
  for (const key of SETTING_ORDER) {
    if (changed.has(key)) info(`  ${lines[key]}`);
  }
  if (changes.features.size > 0) info(t('config_next_push'));
}

/**
 * Turns the typed flags into the values to write, refusing the command on the
 * first value it cannot accept - before anything is written.
 */
async function _resolveChanges(opts: ConfigOpts): Promise<ConfigChanges> {
  const features = _parseFeatureFlags(opts.on ?? [], opts.off ?? []);
  const pushMode = opts.pushMode !== undefined ? parsePushModeFlag(opts.pushMode) : undefined;
  const cacheDir = _resettable(opts.cacheDir, opts.reset);
  const tempDir = _resettable(opts.tempDir, opts.reset);
  if (typeof cacheDir === 'string') await assertUsableDir(cacheDir, 'cache-dir');
  if (typeof tempDir === 'string') await assertUsableDir(tempDir, 'temp-dir');

  const ram = _resettable(opts.maxRam, opts.reset);
  const maxRam = typeof ram === 'string' ? parseMaxRamFlag(ram) : ram;
  return { cacheDir, tempDir, maxRam, pushMode, features };
}

/**
 * Reads a setting that --reset can bring back to default: absent stays absent
 * (undefined), a bare flag or one next to --reset means default (null).
 */
function _resettable(value: string | true | undefined, reset: boolean | undefined): Nullable<string> | undefined {
  if (value === undefined) return undefined;
  return reset === true || value === true ? null : value;
}

/**
 * Reads --on / --off into one map. A feature named twice on the same side is
 * applied once; a feature named on both sides has no answer, so it is refused.
 *
 * @throws CommandAbort for an unknown feature or one named by both flags
 */
function _parseFeatureFlags(on: readonly string[], off: readonly string[]): Map<Feature, boolean> {
  const result = new Map<Feature, boolean>();
  const sides: ReadonlyArray<readonly [readonly string[], boolean]> = [
    [on, true],
    [off, false],
  ];
  for (const [names, enable] of sides) {
    for (const name of names) {
      const key = name.toLowerCase();
      // Own keys only: a name like "constructor" must not resolve through the prototype.
      const feature = Object.hasOwn(FEATURE_MAP, key) ? FEATURE_MAP[key] : undefined;
      if (feature === undefined) {
        error(fmt('config_feature_unknown', name));
        throw new CommandAbort();
      }
      if (result.get(feature) === !enable) {
        error(fmt('config_feature_conflict', feature));
        throw new CommandAbort();
      }
      result.set(feature, enable);
    }
  }
  return result;
}

/** Writes the settled changes into `config` and returns which settings they touched. */
function _applyChanges(config: VaultConfig, changes: ConfigChanges): Set<SettingKey> {
  const changed = new Set<SettingKey>();
  if (changes.cacheDir !== undefined) {
    config.cache_dir = changes.cacheDir;
    changed.add('cache-dir');
  }
  if (changes.tempDir !== undefined) {
    config.temp_dir = changes.tempDir;
    changed.add('temp-dir');
  }
  if (changes.maxRam !== undefined) {
    config.max_ram_mb = changes.maxRam;
    changed.add('max-ram');
  }
  if (changes.pushMode !== undefined) {
    config.push_mode = changes.pushMode;
    changed.add('push-mode');
  }
  for (const [feature, enable] of changes.features) {
    _applyFeature(config, feature, enable);
    changed.add(feature);
  }
  return changed;
}

/** Switches compression or encryption, creating its block with defaults when absent. */
function _applyFeature(config: VaultConfig, feature: Feature, enable: boolean): void {
  switch (feature) {
    case 'compression':
      if (!config.compression) config.compression = { enabled: enable, algorithm: 'deflate' };
      else config.compression.enabled = enable;
      return;
    case 'encryption':
      if (!config.encryption) config.encryption = { enabled: enable, algorithm: 'aes-256-gcm', kdf: 'argon2id' };
      else config.encryption.enabled = enable;
      return;
  }
}

/** Formats every setting the way `bfs config` prints it, so the full view and the change list match. */
function _settingLines(rootDir: string, config: VaultConfig): Record<SettingKey, string> {
  const cacheDefault = path.join(rootDir, '.bfs', 'cache');
  const state = (on: boolean | undefined): string => (on ? t('status_enc_enabled') : t('status_enc_disabled'));
  return {
    'cache-dir': `cache-dir: ${config.cache_dir ?? fmt('config_cache_default', cacheDefault)}`,
    'temp-dir': `temp-dir:  ${config.temp_dir ?? t('config_temp_default')}`,
    'max-ram': `max-ram:   ${_maxRamValue(config.max_ram_mb)}`,
    'push-mode': `push-mode: ${config.push_mode}`,
    compression: `${t('config_label_compression').padEnd(14)} ${state(config.compression?.enabled)}`,
    encryption: `${t('config_label_encryption').padEnd(14)} ${state(config.encryption?.enabled)}`,
  };
}

/** Formats the stored RAM limit, marking a value that leaves push no RAM budget. */
function _maxRamValue(maxRamMb: Nullable<number> | undefined): string {
  if (maxRamMb == null) return t('config_ram_auto');
  return isZeroRamBudget(maxRamMb) ? `${maxRamMb} MB ${t('config_ram_invalid_mark')}` : `${maxRamMb} MB`;
}

/** Prints the vault settings shown by a bare `bfs config`. */
function _printSettings(rootDir: string, config: VaultConfig): void {
  info(t('config_current_settings'));
  const lines = _settingLines(rootDir, config);
  for (const key of SETTING_ORDER) info(`  ${lines[key]}`);
}
