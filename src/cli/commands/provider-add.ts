import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import type { ProviderConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, success, warn } from '../ui.js';

interface ProviderAddOpts {
  ci?: boolean;
  id?: string;
  type?: string;
  path?: string;
}

/**
 * Registers the `bfs provider add` command.
 * Interactively adds a new provider to the vault config.
 * CI mode: use `--ci --id <id> --type local --path <path>` to skip all prompts.
 * Note: Adding a provider changes N+K — user must run `bfs push` after.
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderAdd(providerCmd: Command): void {
  providerCmd
    .command('add')
    .description(t('cmd_provider_add_desc'))
    .option('--ci', 'Non-interactive mode (CI/scripts): skip Inquirer prompts')
    .option('--id <id>', 'New provider ID (CI mode)')
    .option('--type <type>', 'Provider type: local (CI mode)', 'local')
    .option(
      '--path <path>',
      'Provider directory path (CI mode, for type=local)',
    )
    .action(async (opts: ProviderAddOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const isCi = opts.ci === true;

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      if (!isCi) {
        console.log(
          fmt('provider_add_current', String(config.providers.length)),
        );
        for (const p of config.providers) {
          console.log(`  - ${p.id} (${p.type})`);
        }
        warn(t('provider_add_warn'));
      }

      let id: string;
      let type: string;
      let providerConfig: Record<string, unknown> = {};

      if (isCi) {
        if (!opts.id?.trim()) {
          error(t('provider_add_id_required'));
          throw new CommandAbort();
        }
        if (config.providers.some((p) => p.id === opts.id?.trim())) {
          error(fmt('provider_add_exists', opts.id));
          throw new CommandAbort();
        }
        id = opts.id.trim();
        type = opts.type ?? 'local';
        if (type === 'local') {
          if (!opts.path?.trim()) {
            error(t('provider_add_path_required'));
            throw new CommandAbort();
          }
          providerConfig = { path: opts.path.trim() };
        }
      } else {
        const ans = await promptWithRawMode<{ id: string }>([
          {
            type: 'input',
            name: 'id',
            message: t('provider_add_name_prompt'),
            validate: (v: string) => {
              if (!v.trim()) return t('provider_add_name_required');
              if (config.providers.some((p) => p.id === v.trim()))
                return fmt('provider_add_exists', v);
              return true;
            },
          },
        ]);
        id = ans.id.trim();

        const typeAns = await promptWithRawMode<{ type: string }>([
          {
            type: 'rawlist',
            name: 'type',
            message: t('provider_add_type_prompt'),
            choices: ['local'],
          },
        ]);
        type = typeAns.type;

        if (type === 'local') {
          const { dirPath } = await promptWithRawMode<{ dirPath: string }>([
            {
              type: 'input',
              name: 'dirPath',
              message: t('provider_add_dir_prompt'),
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
          providerConfig = { path: dirPath.trim() };
        }
      }

      const newProvider: ProviderConfig = { id, type, config: providerConfig };
      config.providers.push(newProvider);

      // Adjust parity shard count: keep data_shards, increase parity by 1
      config.scheme.parity_shards += 1;

      await writeConfig(rootDir, config);
      success(
        fmt(
          'provider_add_success',
          newProvider.id,
          String(config.scheme.data_shards),
          String(config.scheme.parity_shards),
        ),
      );
    });
}
