import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import type { ProviderConfig } from '../../types/index.js';
import { PushMode } from '../../types/index.js';
import { init } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, formatBytes, info, success } from '../ui.js';

// ─── Provider config prompts ───────────────────────────────────────────────────

/**
 * Interactively prompts the user to configure a single provider.
 * Currently only "local" type is supported.
 *
 * @param index - Provider index (for display purposes)
 * @returns      A ProviderConfig ready for use in VaultConfig.providers
 */
async function promptProvider(index: number): Promise<ProviderConfig> {
  console.log(chalk.bold(fmt('init_provider_header', String(index + 1))));

  const { id } = await promptWithRawMode<{ id: string }>([
    {
      type: 'input',
      name: 'id',
      message: t('init_provider_name_prompt'),
      validate: (v: string) =>
        v.trim() ? true : t('init_provider_name_required'),
    },
  ]);

  const { type } = await promptWithRawMode<{ type: string }>([
    {
      type: 'rawlist',
      name: 'type',
      message: t('init_provider_type_prompt'),
      choices: ['local'],
    },
  ]);

  let config: Record<string, unknown> = {};

  if (type === 'local') {
    const { dirPath } = await promptWithRawMode<{ dirPath: string }>([
      {
        type: 'input',
        name: 'dirPath',
        message: t('init_dir_path_prompt'),
        validate: async (v: string) => {
          if (!v.trim()) return t('path_required');
          try {
            const stat = await fs.stat(v.trim());
            if (!stat.isDirectory()) return t('path_not_dir');
            return true;
          } catch {
            return fmt('dir_not_exist', v);
          }
        },
      },
    ]);
    config = { path: dirPath.trim() };
  }

  return { id: id.trim(), type, config };
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

/**
 * Registers the `bfs init` command on the given Commander program.
 *
 * @param program - Commander program to attach the command to
 */
/**
 * Parses a --provider flag value in the format `type:id:path`.
 *
 * @param spec - Provider spec string, e.g. "local:myusb:/mnt/usb"
 * @returns     ProviderConfig ready for use in VaultConfig
 * @throws      Error if the format is invalid
 */
function parseProviderSpec(spec: string): ProviderConfig {
  const parts = spec.split(':');
  if (parts.length < 3) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }
  const [type, id, ...pathParts] = parts;
  const provPath = pathParts.join(':'); // Windows paths contain ":"
  if (!type || !id || !provPath) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }
  return { id, type, config: { path: provPath } };
}

interface InitCiOpts {
  ci?: boolean;
  enc?: boolean;
  dataShards?: string;
  parityShards?: string;
  provider?: string[];
  pushMode?: string;
  maxRam?: string;
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(t('cmd_init_desc'))
    .argument('[vault_name]', t('init_vault_name_arg'))
    .option('--ci', t('init_opt_ci'))
    .option('--enc', t('init_opt_enc'))
    .option('--data-shards <n>', t('init_opt_data_shards'))
    .option('--parity-shards <n>', t('init_opt_parity_shards'))
    .option(
      '--provider <spec>',
      t('init_opt_provider'),
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--push-mode <mode>', t('init_opt_push_mode'), 'new_version')
    .option('--max-ram <mb>', t('init_opt_max_ram'))
    .action(
      async (argName: string | undefined, ciOpts: InitCiOpts, cmd: Command) => {
        const rootDir = resolveCwd(cmd);

        // ── Vault name ────────────────────────────────────────────────────────
        let vaultName: string;
        if (argName?.trim()) {
          vaultName = argName.trim();
        } else {
          const { name } = await promptWithRawMode<{ name: string }>([
            {
              type: 'input',
              name: 'name',
              message: t('init_vault_name_prompt'),
              validate: (v: string) =>
                v.trim() ? true : t('init_vault_name_required'),
            },
          ]);
          vaultName = name.trim();
        }

        console.log(chalk.bold(t('init_header')));

        // Scan directory
        info(t('init_scanning'));
        const { count, size } = await scanDir(rootDir);
        info(fmt('init_found_files', String(count), formatBytes(size)));

        // ── Tryb CI: --ci + flagi → pomiń wszystkie prompty Inquirer ─────────
        const isCi = ciOpts.ci === true;
        const ciProviders = (ciOpts.provider ?? []).map(parseProviderSpec);
        const ciDataShards = ciOpts.dataShards
          ? parseInt(ciOpts.dataShards, 10)
          : null;
        const ciParityShards = ciOpts.parityShards
          ? parseInt(ciOpts.parityShards, 10)
          : null;

        // ── Encryption ────────────────────────────────────────────────────────
        let encEnabled: boolean;
        if (isCi) {
          encEnabled = ciOpts.enc === true;
        } else {
          const ans = await promptWithRawMode<{ encEnabled: boolean }>([
            {
              type: 'confirm',
              name: 'encEnabled',
              message: t('init_enc_prompt'),
              default: true,
            },
          ]);
          encEnabled = ans.encEnabled;
        }

        // ── N/K scheme ───────────────────────────────────────────────────────
        let dataShardsN: number;
        let parityK: number;
        if (isCi) {
          dataShardsN = ciDataShards as number;
          parityK = ciParityShards as number;
        } else {
          const ans = await promptWithRawMode<{
            dataShardsStr: string;
            parityShardsStr: string;
          }>([
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
        console.log(
          chalk.dim(
            fmt(
              'init_providers_needed',
              String(total),
              String(dataShardsN),
              String(parityK),
            ),
          ),
        );

        // ── Providers ─────────────────────────────────────────────────────────
        let providers: ProviderConfig[];
        if (isCi) {
          providers = ciProviders;
        } else {
          providers = [];
          for (let i = 0; i < total; i++) {
            const prov = await promptProvider(i);
            providers.push(prov);
          }
        }

        // ── Push mode ─────────────────────────────────────────────────────────
        let pushMode: PushMode;
        if (isCi) {
          const m = ciOpts.pushMode ?? PushMode.NewVersion;
          if (
            m !== PushMode.NewVersion &&
            m !== PushMode.Overwrite &&
            m !== PushMode.Ask
          ) {
            error(fmt('init_push_mode_invalid', m));
            throw new CommandAbort();
          }
          pushMode = m;
        } else {
          const ans = await promptWithRawMode<{
            pushMode: PushMode;
          }>([
            {
              type: 'rawlist',
              name: 'pushMode',
              message: t('init_push_mode_prompt'),
              choices: [
                {
                  name: t('init_push_mode_new'),
                  value: PushMode.NewVersion,
                },
                {
                  name: t('init_push_mode_overwrite'),
                  value: PushMode.Overwrite,
                },
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
        const io = createCliProviderIO();
        try {
          await init(rootDir, {
            vault_name: vaultName,
            scheme: { data_shards: dataShardsN, parity_shards: parityK },
            encryption: {
              enabled: encEnabled,
              algorithm: 'aes-256-gcm',
              kdf: 'argon2id',
            },
            providers,
            push_mode: pushMode,
            max_ram_mb: maxRamMb,
            io,
          });
          success(fmt('init_success', vaultName));
        } catch (err) {
          if (err instanceof AbortPromptError) throw err;
          if (err instanceof ExitPromptError) throw err;
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
