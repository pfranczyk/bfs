import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import type { ProviderConfig } from '../../types/index.js';
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
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(t('cmd_init_desc'))
    .argument('[vault_name]', 'Vault name (= subfolder on providers)')
    .option('--ci', 'Non-interactive mode (CI/scripts): skip Inquirer prompts')
    .option(
      '--enc',
      'Enable AES-256-GCM encryption (only with --ci, disabled by default)',
    )
    .option('--data-shards <n>', 'Number of data shards N (CI mode)')
    .option('--parity-shards <n>', 'Number of parity shards K (CI mode)')
    .option(
      '--provider <spec>',
      'Provider in format type:id:path, e.g. local:usb1:/mnt/usb (repeatable)',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option(
      '--push-mode <mode>',
      'Push mode: new_version|overwrite|ask (CI mode)',
      'new_version',
    )
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
        let pushMode: 'new_version' | 'overwrite' | 'ask';
        if (isCi) {
          const m = ciOpts.pushMode ?? 'new_version';
          if (m !== 'new_version' && m !== 'overwrite' && m !== 'ask') {
            error(fmt('init_push_mode_invalid', m));
            throw new CommandAbort();
          }
          pushMode = m;
        } else {
          const ans = await promptWithRawMode<{
            pushMode: 'new_version' | 'overwrite' | 'ask';
          }>([
            {
              type: 'rawlist',
              name: 'pushMode',
              message: t('init_push_mode_prompt'),
              choices: [
                {
                  name: t('init_push_mode_new'),
                  value: 'new_version',
                },
                {
                  name: t('init_push_mode_overwrite'),
                  value: 'overwrite',
                },
                { name: t('init_push_mode_ask'), value: 'ask' },
              ],
              default: 'new_version',
            },
          ]);
          pushMode = ans.pushMode;
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
            io,
          });
          success(fmt('init_success', vaultName));
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
