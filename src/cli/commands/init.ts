import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { estimateCompressibility } from '../../core/compression.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../../providers/provider.js';
import type { ProviderConfig } from '../../types/index.js';
import { PushMode } from '../../types/index.js';
import { init } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { parseInitProviderSpec, validateProviderIdsUnique } from '../parse-provider-spec.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, formatBytes, info, success, warn } from '../ui.js';

// ─── Provider config prompts ───────────────────────────────────────────────────

/**
 * Interactively prompts the user to configure a single provider.
 * The type list comes from providerRegistry; each provider owns its own
 * configuration flow via StorageProvider.configureInteractive().
 *
 * @param index   - Provider index (for display purposes)
 * @param workDir - BFS working directory exposed to the adapter through
 *                  `io.workDir` so its prompts / path resolution respect
 *                  `bfs --cwd`
 * @returns         A ProviderConfig ready for use in VaultConfig.providers
 */
async function promptProvider(index: number, workDir: string): Promise<ProviderConfig> {
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
  const io = createCliProviderIO(workDir);
  const placeholder = factory.create({ id: id.trim(), type, adapterPackage, config: {} }, io);
  const config = await placeholder.configureInteractive(io);

  return { id: id.trim(), type, adapterPackage, config };
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

      // ── CI mode: validate ALL flags before doing anything ────────────────
      // In --ci the user contractually provides every required value; we
      // must neither fall into prompts nor let null/NaN reach the config.
      const isCi = ciOpts.ci === true;
      const ciDataShardsRaw = ciOpts.dataShards;
      const ciParityShardsRaw = ciOpts.parityShards;
      let ciDataShards: Nullable<number> = null;
      let ciParityShards: Nullable<number> = null;
      let ciProviders: ProviderConfig[] = [];

      if (isCi) {
        if (!argName?.trim()) {
          error(t('init_ci_name_required'));
          throw new CommandAbort();
        }
        if (!ciDataShardsRaw || !ciParityShardsRaw) {
          error(t('init_ci_scheme_required'));
          throw new CommandAbort();
        }
        const parsedData = parseInt(ciDataShardsRaw, 10);
        if (!Number.isInteger(parsedData) || parsedData < 2) {
          error(fmt('init_ci_data_shards_invalid', ciDataShardsRaw));
          throw new CommandAbort();
        }
        const parsedParity = parseInt(ciParityShardsRaw, 10);
        if (!Number.isInteger(parsedParity) || parsedParity < 1) {
          error(fmt('init_ci_parity_shards_invalid', ciParityShardsRaw));
          throw new CommandAbort();
        }
        try {
          ciProviders = await Promise.all((ciOpts.provider ?? []).map((spec) => parseInitProviderSpec(spec, rootDir)));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
        const required = parsedData + parsedParity;
        if (ciProviders.length !== required) {
          error(fmt('init_ci_providers_required', String(required), String(parsedData), String(parsedParity)));
          throw new CommandAbort();
        }
        // Push mode validated early so we abort before scanning the directory.
        const m = ciOpts.pushMode ?? PushMode.NewVersion;
        if (m !== PushMode.NewVersion && m !== PushMode.Overwrite && m !== PushMode.Ask) {
          error(fmt('init_push_mode_invalid', m));
          throw new CommandAbort();
        }
        ciDataShards = parsedData;
        ciParityShards = parsedParity;
      } else {
        // Interactive mode — --provider flags (if any) are parsed the same way;
        // format errors surface immediately as CommandAbort rather than a stack.
        try {
          ciProviders = await Promise.all((ciOpts.provider ?? []).map((spec) => parseInitProviderSpec(spec, rootDir)));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      }

      // ── Vault name ────────────────────────────────────────────────────────
      let vaultName: string;
      if (argName?.trim()) {
        vaultName = argName.trim();
      } else {
        const { name } = await promptWithRawMode<{ name: string }>([{ type: 'input', name: 'name', message: t('init_vault_name_prompt'), validate: (v: string) => (v.trim() ? true : t('init_vault_name_required')) }]);
        vaultName = name.trim();
      }

      console.log(chalk.bold(t('init_header')));

      // Scan directory
      info(t('init_scanning'));
      const { count, size } = await scanDir(rootDir);
      info(fmt('init_found_files', String(count), formatBytes(size)));

      // ── Encryption ────────────────────────────────────────────────────────
      // Encryption is ON by default. --no-enc opts out (honored in any mode).
      // --enc is accepted but a no-op (kept for script compatibility). Because
      // --enc is declared before --no-enc, Commander leaves `enc` undefined when
      // neither flag is given and sets it to false only for --no-enc, so
      // `ciOpts.enc === false` precisely detects an explicit opt-out.
      let encEnabled: boolean;
      if (ciOpts.enc === false) {
        encEnabled = false;
      } else if (isCi) {
        encEnabled = true;
      } else {
        const ans = await promptWithRawMode<{ encEnabled: boolean }>([{ type: 'confirm', name: 'encEnabled', message: t('init_enc_prompt'), default: true }]);
        encEnabled = ans.encEnabled;
      }
      if (!encEnabled) {
        warn(t('vault_unencrypted_warning'));
      }

      // ── Compression ───────────────────────────────────────────────────────
      let compressEnabled: boolean;
      // Detect whether user provided --compress or --no-compress explicitly.
      // Commander defaults compress=true via --no-compress registration, so we
      // check argv directly to distinguish "explicit" from "no flag given".
      const hasExplicitCompress = process.argv.some((a) => a === '--compress' || a === '--no-compress');

      if (hasExplicitCompress) {
        // Explicit flag → use as-is, skip detection
        compressEnabled = ciOpts.compress !== false;
      } else {
        // No flag → run compressibility analysis, use smart default
        info(t('init_compress_scanning'));
        const cr = await estimateCompressibility(rootDir);
        const ratioPercent = Math.round(cr.ratio * 100);
        const defaultCompress = cr.ratio <= 0.7;

        if (cr.ratio > 0.7) {
          info(fmt('init_compress_skip_suggest', String(ratioPercent), cr.topIncompressible.join(', ')));
        } else {
          info(t('init_compress_auto_on'));
        }

        if (isCi) {
          compressEnabled = defaultCompress;
        } else {
          const ans = await promptWithRawMode<{ compressEnabled: boolean }>([{ type: 'confirm', name: 'compressEnabled', message: t('init_compress_prompt'), default: defaultCompress }]);
          compressEnabled = ans.compressEnabled;
        }
      }

      // ── N/K scheme ───────────────────────────────────────────────────────
      let dataShardsN: number;
      let parityK: number;
      if (isCi) {
        if (ciDataShards === null || ciParityShards === null) {
          // Unreachable: CI validation above guarantees both are set.
          throw new Error('invariant: CI scheme values validated earlier');
        }
        dataShardsN = ciDataShards;
        parityK = ciParityShards;
      } else {
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
        dataShardsN = parseInt(ans.dataShardsStr, 10);
        parityK = parseInt(ans.parityShardsStr, 10);
      }

      const total = dataShardsN + parityK;
      console.log(chalk.dim(fmt('init_providers_needed', String(total), String(dataShardsN), String(parityK))));

      // ── Providers ─────────────────────────────────────────────────────────
      let providers: ProviderConfig[];
      if (isCi) {
        providers = ciProviders;
      } else {
        providers = [];
        for (let i = 0; i < total; i++) {
          const prov = await promptProvider(i, rootDir);
          providers.push(prov);
        }
      }

      // Provider ids must be unique — a duplicate would silently orphan shards
      // (lookup by id resolves to the first match). Covers CI and interactive.
      try {
        validateProviderIdsUnique(providers.map((p) => p.id));
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }

      // ── Push mode ─────────────────────────────────────────────────────────
      let pushMode: PushMode;
      if (isCi) {
        const m = ciOpts.pushMode ?? PushMode.NewVersion;
        if (m !== PushMode.NewVersion && m !== PushMode.Overwrite && m !== PushMode.Ask) {
          error(fmt('init_push_mode_invalid', m));
          throw new CommandAbort();
        }
        pushMode = m;
      } else {
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
        pushMode = ans.pushMode;
      }

      // ── RAM limit ──────────────────────────────────────────────────────────
      let maxRamMb: Nullable<number>;
      if (isCi) {
        maxRamMb = ciOpts.maxRam ? parseInt(ciOpts.maxRam, 10) : null;
      } else {
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
        maxRamMb = parseInt(ans.maxRamStr, 10);
      }

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
