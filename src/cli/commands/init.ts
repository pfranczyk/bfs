import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { estimateCompressibility } from '../../core/compression.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId, validateVaultName } from '../../providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../types/index.js';
import { PushMode } from '../../types/index.js';
import { init } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { parseInitProviderSpec, validateProviderIdsUnique } from '../parse-provider-spec.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { probeProviderWithRecovery } from '../provider-probe.js';
import { CommandAbort, error, formatBytes, info, success, warn } from '../ui.js';

// ─── Provider config prompts ───────────────────────────────────────────────────

/**
 * Interactively prompts the user to configure a single provider.
 * The type list comes from providerRegistry; each provider owns its own
 * configuration flow via StorageProvider.configureInteractive().
 *
 * @param index     - Provider index (for display purposes)
 * @param workDir   - BFS working directory exposed to the adapter through
 *                    `io.workDir` so its prompts / path resolution respect
 *                    `bfs --cwd`
 * @param vaultName - Vault name the connectivity probe resolves its path against
 * @returns           A ProviderConfig ready for use in VaultConfig.providers
 */
async function promptProvider(index: number, workDir: string, vaultName: string): Promise<ProviderConfig> {
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

// ─── Command ───────────────────────────────────────────────────────────────────

interface InitCiOpts {
  ci?: boolean;
  enc?: boolean;
  /**
   * Tri-state: true = --compress, false = --no-compress, undefined = neither.
   * Detection: process.argv check before Commander defaults kick in.
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
      const isCi = ciOpts.ci === true;

      // CI mode validates ALL flags up front so we abort before scanning the
      // directory; interactive mode only parses the optional --provider specs
      // here and defers scheme / push-mode / RAM to prompts further down.
      let ciDataShards: Nullable<number> = null;
      let ciParityShards: Nullable<number> = null;
      let ciProviders: ProviderConfig[] = [];
      if (isCi) {
        const ci = await _resolveCiInputs(argName, ciOpts, rootDir);
        ciDataShards = ci.dataShards;
        ciParityShards = ci.parityShards;
        ciProviders = ci.providers;
      } else {
        ciProviders = await _parseProviderSpecs(ciOpts.provider ?? [], createCliProviderIO(rootDir, !isCi));
      }

      const vaultName = await _resolveVaultName(argName);

      console.log(chalk.bold(t('init_header')));
      info(t('init_scanning'));
      const { count, size } = await scanDir(rootDir);
      info(fmt('init_found_files', String(count), formatBytes(size)));

      const encEnabled = await _resolveEncryption(ciOpts, isCi);
      if (!encEnabled) {
        warn(t('vault_unencrypted_warning'));
      }

      const compressEnabled = await _resolveCompression(ciOpts, isCi, rootDir);

      const { dataShardsN, parityK } = await _resolveScheme(isCi, ciDataShards, ciParityShards);
      const total = dataShardsN + parityK;
      console.log(chalk.dim(fmt('init_providers_needed', String(total), String(dataShardsN), String(parityK))));

      const providers = isCi ? ciProviders : await _promptProviders(total, rootDir, vaultName);
      // Provider ids must be unique — a duplicate would silently orphan shards
      // (lookup by id resolves to the first match). Covers CI and interactive.
      try {
        validateProviderIdsUnique(providers.map((p) => p.id));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }

      const pushMode = await _resolvePushMode(ciOpts, isCi);
      const maxRamMb = await _resolveMaxRam(ciOpts, isCi);

      // Execute
      const io = createCliProviderIO(rootDir);
      try {
        await init(rootDir, {
          vault_name: vaultName,
          scheme: { data_shards: dataShardsN, parity_shards: parityK },
          encryption: { enabled: encEnabled, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
          compression: { enabled: compressEnabled, algorithm: 'deflate' },
          providers,
          push_mode: pushMode,
          max_ram_mb: maxRamMb,
          io,
        });
        success(fmt('init_success', vaultName));
      } catch (err) {
        if (isPromptCancellation(err)) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}

// ─── Section resolvers (private) ─────────────────────────────────────────────────

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
 * flag wins; otherwise a compressibility analysis picks a smart default (and in
 * interactive mode pre-fills the prompt with it).
 */
async function _resolveCompression(ciOpts: InitCiOpts, isCi: boolean, rootDir: string): Promise<boolean> {
  // Commander defaults compress=true via --no-compress registration, so we check
  // argv directly to distinguish "explicit flag" from "no flag given".
  const hasExplicitCompress = process.argv.some((a) => a === '--compress' || a === '--no-compress');
  if (hasExplicitCompress) {
    return ciOpts.compress !== false;
  }

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
 * Resolves the N/K Reed-Solomon scheme — pre-validated CI values or interactive
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

/** Prompts interactively for `total` providers, one at a time. */
async function _promptProviders(total: number, rootDir: string, vaultName: string): Promise<ProviderConfig[]> {
  const providers: ProviderConfig[] = [];
  for (let i = 0; i < total; i++) {
    const prov = await promptProvider(i, rootDir, vaultName);
    providers.push(prov);
  }
  return providers;
}

/** Resolves the push mode — validated CI flag or interactive choice. */
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
 * Resolves the RAM ceiling in MiB — the CI flag (or null) or an interactive
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
