import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { estimateCompressibility } from '../../core/compression.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId, validateVaultName } from '../../providers/provider.js';
import type { ProviderConfig, ProviderIO, VaultConfig } from '../../types/index.js';
import { PushMode } from '../../types/index.js';
import { type InitTarget, inspectInitTarget } from '../../vault/config.js';
import { admitInitProvider, type InitOptions, type InitSettings, init } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { parseInitProviderSpec, validateProviderIdsUnique } from '../parse-provider-spec.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { probeProviderWithRecovery } from '../provider-probe.js';
import { CommandAbort, error, formatBytes, info, success, warn } from '../ui.js';

// --- Provider config prompts ---------------------------------------------------

/** Inputs for {@link promptProvider}. */
interface PromptProviderOptions {
  /** Provider index (for display purposes). */
  index: number;
  /**
   * BFS working directory exposed to the adapter through `io.workDir` so its
   * prompts / path resolution respect `bfs --cwd`.
   */
  workDir: string;
  /** Vault name the connectivity probe resolves its path against. */
  vaultName: string;
  /** Storage names already in use - recorded or typed earlier in this run. */
  taken: string[];
}

/**
 * Interactively prompts the user to configure a single provider.
 * The type list comes from providerRegistry; each provider owns its own
 * configuration flow via StorageProvider.configureInteractive(). A name already
 * in use is refused at the prompt: storages are written to config.json as they
 * pass, so a later check would come after the duplicate is on disk.
 *
 * @param options - Index, working directory, vault name and taken names
 * @returns         A ProviderConfig ready for use in VaultConfig.providers
 */
async function promptProvider({ index, workDir, vaultName, taken }: PromptProviderOptions): Promise<ProviderConfig> {
  console.log(chalk.bold(fmt('init_provider_header', String(index + 1))));

  const { id } = await promptWithRawMode<{ id: string }>([
    {
      type: 'input',
      name: 'id',
      message: t('init_provider_name_prompt'),
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return t('init_provider_name_required');
        try {
          validateProviderId(trimmed);
          validateProviderIdsUnique([trimmed], taken);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        return true;
      },
    },
  ]);

  const { type } = await promptWithRawMode<{ type: string }>([{ type: 'rawlist', name: 'type', message: t('init_provider_type_prompt'), choices: providerRegistry.listTypes().map((pt) => ({ name: pt.displayName, value: pt.type })) }]);

  const factory = providerRegistry.getFactory(type);
  if (!factory) {
    throw new Error(`Unknown provider type: ${type}`);
  }
  const meta = providerRegistry.getMeta(type);
  const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
  const providerId = id.trim();
  const io = createCliProviderIO(workDir);
  const config = await probeProviderWithRecovery({ factory, ref: { id: providerId, type, adapterPackage }, io, vaultName });

  return { id: providerId, type, adapterPackage, config };
}

/**
 * Scans a directory and returns the count and total size of files (excluding .bfs/).
 *
 * @param dir - Directory to scan
 * @returns    An object with file count and total size in bytes
 */
async function scanDir(dir: string): Promise<{ count: number; size: number }> {
  let count = 0;
  let size = 0;

  async function walk(d: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.bfs') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const stat = await fs.stat(full);
        count++;
        size += stat.size;
      }
    }
  }

  await walk(dir);
  return { count, size };
}

// --- Command -------------------------------------------------------------------

interface InitCiOpts {
  ci?: boolean;
  enc?: boolean;
  /**
   * Tri-state: true = --compress, false = --no-compress, undefined = neither
   * (--compress is registered before --no-compress, so Commander sets no default).
   */
  compress?: boolean;
  dataShards?: string;
  parityShards?: string;
  provider?: string[];
  pushMode?: string;
  maxRam?: string;
}

/** Validated CI inputs gathered before any directory scan. */
interface CiInputs {
  dataShards: number;
  parityShards: number;
  providers: ProviderConfig[];
}

/**
 * Registers the `bfs init` command on the given Commander program.
 *
 * @param program - Commander program to attach the command to
 */
export function registerInit(program: Command): void {
  program
    .command('init')
    .description(t('cmd_init_desc'))
    .argument('[vault_name]', t('init_vault_name_arg'))
    .option('--ci', t('init_opt_ci'))
    .option('--enc', t('init_opt_enc'))
    .option('--no-enc', t('init_opt_no_enc'))
    .option('--compress', t('init_opt_compress'))
    .option('--no-compress', t('init_opt_no_compress'))
    .option('--data-shards <n>', t('init_opt_data_shards'))
    .option('--parity-shards <n>', t('init_opt_parity_shards'))
    .option('--provider <spec>', t('init_opt_provider'), (v: string, prev: string[]) => [...prev, v], [] as string[])
    .option('--push-mode <mode>', t('init_opt_push_mode'), 'new_version')
    .option('--max-ram <mb>', t('init_opt_max_ram'))
    .action(async (argName: string | undefined, ciOpts: InitCiOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      // First thing, before the directory scan and before a single prompt: the
      // interactive path probes every medium from promptProvider, and probing
      // creates the target sub-directory. Refusing later would mean taking the
      // operator through the whole questionnaire - passwords included - and
      // leaving a directory for the new name on each medium, only to say no.
      let target: InitTarget;
      try {
        target = await inspectInitTarget(rootDir);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }

      const isCi = isCiRun(cmd, ciOpts.ci);

      // CI mode validates ALL flags up front so we abort before scanning the
      // directory; interactive mode only parses the optional --provider specs
      // here and defers scheme / push-mode / RAM to prompts further down.
      let ciInputs: Nullable<CiInputs> = null;
      if (isCi) {
        ciInputs = await _resolveCiInputs(argName, ciOpts, rootDir);
      } else {
        // No second argument: leave the answer to the TTY check inside
        // createCliProviderIO. This branch only runs when --ci is absent, so a
        // literal `!isCi` would claim a terminal for every run - including one
        // whose stdin is a pipe, where an adapter reading the field would ask a
        // question nobody can answer instead of refusing outright.
        await _parseProviderSpecs(ciOpts.provider ?? [], createCliProviderIO(rootDir));
      }

      if (!isCi && target.kind === 'resume') {
        await _resumeInteractive(rootDir, target.config, { argName, ciOpts });
        return;
      }

      const vaultName = await _resolveVaultName(argName);
      const recorded = target.kind === 'resume' ? target.config : null;

      console.log(chalk.bold(t('init_header')));
      info(t('init_scanning'));
      const { count, size } = await scanDir(rootDir);
      info(fmt('init_found_files', String(count), formatBytes(size)));

      const encEnabled = await _resolveEncryption(ciOpts, isCi);
      if (!encEnabled) {
        warn(t('vault_unencrypted_warning'));
      }

      const compressEnabled = await _resolveCompression(ciOpts, rootDir, { isCi, recorded });

      const { dataShardsN, parityK } = await _resolveScheme(isCi, ciInputs?.dataShards ?? null, ciInputs?.parityShards ?? null);
      const total = dataShardsN + parityK;

      // Asked before the storages: each storage is written to config.json as it
      // passes, so the file carries the operator's choice from its first write.
      const pushMode = await _resolvePushMode(ciOpts, isCi);
      const maxRamMb = await _resolveMaxRam(ciOpts, isCi);

      console.log(chalk.dim(fmt('init_providers_needed', String(total), String(dataShardsN), String(parityK))));

      const settings: InitSettings = {
        vault_name: vaultName,
        scheme: { data_shards: dataShardsN, parity_shards: parityK },
        encryption: { enabled: encEnabled, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        compression: { enabled: compressEnabled, algorithm: 'deflate' },
        push_mode: pushMode,
        max_ram_mb: maxRamMb,
      };
      const providers = ciInputs !== null ? ciInputs.providers : await _promptProviders({ count: total, rootDir, settings, recorded: [] });
      // Provider ids must be unique - a duplicate would silently orphan shards
      // (lookup by id resolves to the first match). The interactive prompt
      // refuses one as it is typed; this covers the --provider list.
      try {
        validateProviderIdsUnique(providers.map((p) => p.id));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }

      await _runInit(rootDir, { ...settings, providers }, isCi);
    });
}

/**
 * Interactive `bfs init` in a directory an interrupted init left behind: the
 * settings come from the file and only the missing storages are asked for. A
 * backup name or an explicit --enc/--no-enc/--compress/--no-compress that
 * differs from the file is refused before any question, naming the difference.
 */
async function _resumeInteractive(rootDir: string, recorded: VaultConfig, { argName, ciOpts }: { argName: string | undefined; ciOpts: InitCiOpts }): Promise<void> {
  const mismatch = _interactiveResumeMismatch(recorded, argName, ciOpts);
  if (mismatch !== null) {
    error(mismatch);
    throw new CommandAbort();
  }
  const { data_shards: N, parity_shards: K } = recorded.scheme;
  const missing = N + K - recorded.providers.length;
  console.log(chalk.bold(t('init_header')));
  info(fmt('init_resume_info', recorded.vault_name, String(recorded.providers.length), String(N + K), String(missing)));
  if (!recorded.encryption.enabled) warn(t('vault_unencrypted_warning'));

  const { vault_id: _id, version: _v, providers: _p, ...rest } = recorded;
  const settings: InitSettings = { ...rest, max_ram_mb: recorded.max_ram_mb ?? null };
  const added = await _promptProviders({ count: missing, rootDir, settings, recorded: recorded.providers });
  await _runInit(rootDir, { ...settings, providers: [...recorded.providers, ...added] }, false);
}

/** The refusal for an interactive resume asked to change what is recorded, or null. */
function _interactiveResumeMismatch(recorded: VaultConfig, argName: string | undefined, ciOpts: InitCiOpts): Nullable<string> {
  const asked = argName?.trim();
  if (asked && asked !== recorded.vault_name) return fmt('init_resume_name_mismatch', recorded.vault_name, asked);
  const onOff = (v: boolean): string => t(v ? 'init_setting_on' : 'init_setting_off');
  if (ciOpts.enc !== undefined && ciOpts.enc !== recorded.encryption.enabled) {
    return fmt('init_resume_setting_mismatch', t('init_setting_encryption'), onOff(recorded.encryption.enabled), onOff(ciOpts.enc));
  }
  if (ciOpts.compress !== undefined && ciOpts.compress !== recorded.compression.enabled) {
    return fmt('init_resume_setting_mismatch', t('init_setting_compression'), onOff(recorded.compression.enabled), onOff(ciOpts.compress));
  }
  return null;
}

/**
 * Runs the vault-level init (which probes and records the storages not yet in
 * config.json) and reports the outcome.
 *
 * `init` in src/vault/vault-manager.ts probes every storage under this IO, and
 * that is where a server identity gets settled - so `--ci` has to state outright
 * that nobody is at the keyboard, or FTPS and SSH reach the rung of their trust
 * ladder that asks instead of the one that refuses. Anything other than `--ci`
 * leaves the answer to the TTY check inside createCliProviderIO, the other half
 * of the contract at `ProviderIO.interactive`.
 */
async function _runInit(rootDir: string, options: Omit<InitOptions, 'io'>, isCi: boolean): Promise<void> {
  const io = createCliProviderIO(rootDir, isCi ? false : undefined);
  try {
    await init(rootDir, { ...options, io });
    success(fmt('init_success', options.vault_name));
  } catch (err) {
    if (isPromptCancellation(err)) throw err;
    error(err instanceof Error ? err.message : String(err));
    throw new CommandAbort();
  }
}

// --- Section resolvers (private) -------------------------------------------------

/**
 * Parses --provider specs into provider configs, aborting the command with a
 * clean message (not a stack) on the first malformed spec.
 */
async function _parseProviderSpecs(specs: string[], io: ProviderIO): Promise<ProviderConfig[]> {
  try {
    return await Promise.all(specs.map((spec) => parseInitProviderSpec(spec, io)));
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    throw new CommandAbort();
  }
}

/**
 * Validates every required --ci flag before any directory work and returns the
 * parsed scheme and providers. In --ci the user contractually supplies every
 * value; we must neither fall into prompts nor let null/NaN reach the config.
 */
async function _resolveCiInputs(argName: string | undefined, ciOpts: InitCiOpts, rootDir: string): Promise<CiInputs> {
  if (!argName?.trim()) {
    error(t('init_ci_name_required'));
    throw new CommandAbort();
  }
  if (!ciOpts.dataShards || !ciOpts.parityShards) {
    error(t('init_ci_scheme_required'));
    throw new CommandAbort();
  }
  const dataShards = parseInt(ciOpts.dataShards, 10);
  if (!Number.isInteger(dataShards) || dataShards < 2) {
    error(fmt('init_ci_data_shards_invalid', ciOpts.dataShards));
    throw new CommandAbort();
  }
  const parityShards = parseInt(ciOpts.parityShards, 10);
  if (!Number.isInteger(parityShards) || parityShards < 1) {
    error(fmt('init_ci_parity_shards_invalid', ciOpts.parityShards));
    throw new CommandAbort();
  }
  const io = createCliProviderIO(rootDir, false);
  const providers = await _parseProviderSpecs(ciOpts.provider ?? [], io);
  const required = dataShards + parityShards;
  if (providers.length !== required) {
    error(fmt('init_ci_providers_required', String(required), String(dataShards), String(parityShards)));
    throw new CommandAbort();
  }
  // Push mode validated early so we abort before scanning the directory.
  const m = ciOpts.pushMode ?? PushMode.NewVersion;
  if (m !== PushMode.NewVersion && m !== PushMode.Overwrite && m !== PushMode.Ask) {
    error(fmt('init_push_mode_invalid', m));
    throw new CommandAbort();
  }
  return { dataShards, parityShards, providers };
}

/**
 * Resolves the vault name from the positional argument or an interactive prompt,
 * then validates it. A vault name becomes a path segment on every medium, so
 * separators and traversal are rejected before it reaches any provider.
 */
async function _resolveVaultName(argName: string | undefined): Promise<string> {
  let vaultName: string;
  if (argName?.trim()) {
    vaultName = argName.trim();
  } else {
    const { name } = await promptWithRawMode<{ name: string }>([{ type: 'input', name: 'name', message: t('init_vault_name_prompt'), validate: (v: string) => (v.trim() ? true : t('init_vault_name_required')) }]);
    vaultName = name.trim();
  }
  try {
    validateVaultName(vaultName);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    throw new CommandAbort();
  }
  return vaultName;
}

/**
 * Resolves whether encryption is enabled. ON by default; --no-enc opts out in
 * any mode (Commander leaves `enc` undefined unless --no-enc sets it false).
 * --enc is accepted but a no-op (kept for script compatibility).
 */
async function _resolveEncryption(ciOpts: InitCiOpts, isCi: boolean): Promise<boolean> {
  if (ciOpts.enc === false) return false;
  if (isCi) return true;
  const ans = await promptWithRawMode<{ encEnabled: boolean }>([{ type: 'confirm', name: 'encEnabled', message: t('init_enc_prompt'), default: true }]);
  return ans.encEnabled;
}

/**
 * Resolves whether compression is enabled. An explicit --compress/--no-compress
 * flag wins. Compression has no fixed default, so without a flag a resume keeps
 * the recorded value, and a new backup gets a compressibility analysis that picks
 * a smart default (pre-filling the prompt with it in interactive mode).
 */
async function _resolveCompression(ciOpts: InitCiOpts, rootDir: string, { isCi, recorded }: { isCi: boolean; recorded: Nullable<VaultConfig> }): Promise<boolean> {
  // Read from the parsed options, not process.argv: --compress is registered
  // before --no-compress, so Commander leaves the value undefined unless one of
  // them was given - whoever ran the parser (the CLI, the REPL, a test).
  if (ciOpts.compress !== undefined) return ciOpts.compress;
  if (recorded !== null) return recorded.compression.enabled;

  info(t('init_compress_scanning'));
  const cr = await estimateCompressibility(rootDir);
  const ratioPercent = Math.round(cr.ratio * 100);
  const defaultCompress = cr.ratio <= 0.7;
  if (cr.ratio > 0.7) {
    info(fmt('init_compress_skip_suggest', String(ratioPercent), cr.topIncompressible.join(', ')));
  } else {
    info(t('init_compress_auto_on'));
  }

  if (isCi) return defaultCompress;
  const ans = await promptWithRawMode<{ compressEnabled: boolean }>([{ type: 'confirm', name: 'compressEnabled', message: t('init_compress_prompt'), default: defaultCompress }]);
  return ans.compressEnabled;
}

/**
 * Resolves the N/K Reed-Solomon scheme - pre-validated CI values or interactive
 * prompts. CI values are guaranteed non-null by _resolveCiInputs.
 */
async function _resolveScheme(isCi: boolean, ciDataShards: Nullable<number>, ciParityShards: Nullable<number>): Promise<{ dataShardsN: number; parityK: number }> {
  if (isCi) {
    if (ciDataShards === null || ciParityShards === null) {
      throw new Error('invariant: CI scheme values validated earlier');
    }
    return { dataShardsN: ciDataShards, parityK: ciParityShards };
  }
  const ans = await promptWithRawMode<{ dataShardsStr: string; parityShardsStr: string }>([
    {
      type: 'input',
      name: 'dataShardsStr',
      message: t('init_data_shards_prompt'),
      default: '2',
      validate: (v: string) => {
        const n = parseInt(v, 10);
        return n >= 2 ? true : t('init_data_shards_min');
      },
    },
    {
      type: 'input',
      name: 'parityShardsStr',
      message: t('init_parity_shards_prompt'),
      default: '1',
      validate: (v: string) => {
        const n = parseInt(v, 10);
        return n >= 1 ? true : t('init_parity_shard_min');
      },
    },
  ]);
  return { dataShardsN: parseInt(ans.dataShardsStr, 10), parityK: parseInt(ans.parityShardsStr, 10) };
}

/** Inputs for {@link _promptProviders}. */
interface PromptProvidersOptions {
  /** How many storages to ask for. */
  count: number;
  /** BFS working directory (respects `bfs --cwd`). */
  rootDir: string;
  /** Settings written with the first storage. */
  settings: InitSettings;
  /** Storages already in config.json (a resume) - their names are taken. */
  recorded: ProviderConfig[];
}

/**
 * Prompts interactively for `count` storages, one at a time. Each one except the
 * last is written to config.json as soon as it passes its probe, so an init cut
 * short keeps it; the last is written by the vault-level init, which probes it
 * once more and completes the configuration. A storage whose location already
 * holds another backup ends the command - no prompt, no way past it.
 */
async function _promptProviders({ count, rootDir, settings, recorded }: PromptProvidersOptions): Promise<ProviderConfig[]> {
  const added: ProviderConfig[] = [];
  for (let i = 0; i < count; i++) {
    const taken = [...recorded, ...added].map((p) => p.id);
    const prov = await promptProvider({ index: recorded.length + i, workDir: rootDir, vaultName: settings.vault_name, taken });
    added.push(prov);
    if (i === count - 1) break;
    try {
      await admitInitProvider(rootDir, { settings, provider: prov, io: createCliProviderIO(rootDir) });
    } catch (err) {
      if (isPromptCancellation(err)) throw err;
      error(err instanceof Error ? err.message : String(err));
      throw new CommandAbort();
    }
  }
  return added;
}

/** Resolves the push mode - validated CI flag or interactive choice. */
async function _resolvePushMode(ciOpts: InitCiOpts, isCi: boolean): Promise<PushMode> {
  if (isCi) {
    const m = ciOpts.pushMode ?? PushMode.NewVersion;
    if (m !== PushMode.NewVersion && m !== PushMode.Overwrite && m !== PushMode.Ask) {
      error(fmt('init_push_mode_invalid', m));
      throw new CommandAbort();
    }
    return m;
  }
  const ans = await promptWithRawMode<{ pushMode: PushMode }>([
    {
      type: 'rawlist',
      name: 'pushMode',
      message: t('init_push_mode_prompt'),
      choices: [
        { name: t('init_push_mode_new'), value: PushMode.NewVersion },
        { name: t('init_push_mode_overwrite'), value: PushMode.Overwrite },
        { name: t('init_push_mode_ask'), value: PushMode.Ask },
      ],
      default: PushMode.NewVersion,
    },
  ]);
  return ans.pushMode;
}

/**
 * Resolves the RAM ceiling in MiB - the CI flag (or null) or an interactive
 * prompt pre-filled with 25% of detected memory (capped at 4096).
 */
async function _resolveMaxRam(ciOpts: InitCiOpts, isCi: boolean): Promise<Nullable<number>> {
  if (isCi) {
    return ciOpts.maxRam ? parseInt(ciOpts.maxRam, 10) : null;
  }
  const detectedRam = Math.round(os.totalmem() / (1024 * 1024));
  const suggested = Math.min(4096, Math.round(detectedRam * 0.25));
  const ans = await promptWithRawMode<{ maxRamStr: string }>([
    {
      type: 'input',
      name: 'maxRamStr',
      message: fmt('init_max_ram_prompt', String(detectedRam)),
      default: String(suggested),
      validate: (v: string) => {
        const n = parseInt(v, 10);
        return n > 0 ? true : 'Must be a positive number';
      },
    },
  ]);
  return parseInt(ans.maxRamStr, 10);
}
