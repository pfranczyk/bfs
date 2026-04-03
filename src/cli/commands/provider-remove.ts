import fs from 'node:fs/promises';
import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import type { ProviderConfig, VaultConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { listVersions, removeProvider } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

/**
 * Registers the `bfs provider remove <id>` command.
 * Shows impact on versions, asks for strategy (relocate/rebuild/remove),
 * and applies the chosen strategy via vault-manager.removeProvider().
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
interface ProviderRemoveOpts {
  password?: string;
  strategy?: string;
  newPath?: string;
  newType?: string;
  target?: string;
  scope?: string;
  yes?: boolean;
}

export function registerProviderRemove(providerCmd: Command): void {
  providerCmd
    .command('remove [id]')
    .description(t('cmd_provider_remove_desc'))
    .option('--password <password>', t('provider_remove_opt_password'))
    .option('--strategy <strategy>', t('provider_remove_opt_strategy'))
    .option('--new-path <path>', t('provider_remove_opt_new_path'))
    .option('--new-type <type>', t('provider_remove_opt_new_type'))
    .option('--target <id>', t('provider_remove_opt_target'))
    .option('--scope <scope>', t('provider_remove_opt_scope'), 'all')
    .option('--yes', t('provider_remove_opt_yes'))
    .action(
      async (
        providerId: string | undefined,
        opts: ProviderRemoveOpts,
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const io = createCliProviderIO();

        const config = await readConfig(rootDir);
        if (!config) {
          error(t('no_config'));
          throw new CommandAbort();
        }

        if (!providerId) {
          if (config.providers.length === 0) {
            error(t('provider_remove_no_providers'));
            throw new CommandAbort();
          }
          const { chosen } = await promptWithRawMode<{ chosen: string }>([
            {
              type: 'rawlist',
              name: 'chosen',
              message: t('provider_remove_prompt'),
              choices: [
                ...config.providers.map((p, i) => ({
                  name: `[${i}] ${p.id}  (${p.type || '?'})`,
                  value: p.id,
                })),
                { name: t('cancel'), value: '__cancel__' },
              ],
            },
          ]);
          if (chosen === '__cancel__') {
            console.log(t('cancelled'));
            return;
          }
          providerId = chosen;
        }

        // Accept numeric index (from `provider list`) or string ID
        const idx = Number(providerId);
        if (
          !Number.isNaN(idx) &&
          Number.isInteger(idx) &&
          config.providers[idx]
        ) {
          providerId = config.providers[idx].id;
        }

        const providerExists = config.providers.some(
          (p) => p.id === providerId,
        );
        if (!providerExists) {
          error(fmt('provider_remove_not_found', providerId));
          throw new CommandAbort();
        }

        // Show impact on versions
        const manifests = await listVersions(rootDir);
        const affectedVersions = manifests.filter((m) =>
          m.shards.some((s) => s.provider_id === providerId),
        );

        if (affectedVersions.length > 0) {
          warn(
            fmt(
              'provider_remove_impact',
              providerId,
              String(affectedVersions.length),
            ),
          );
          for (const m of affectedVersions) {
            const shardIdx =
              m.shards.find((s) => s.provider_id === providerId)?.shard_index ??
              '?';
            info(
              `  v${String(m.version).padStart(3, '0')} — shard_${shardIdx} ` +
                chalk.dim(`(${m.health})`),
            );
          }
          console.log();
          info(t('provider_remove_impact_warn'));
          console.log();
        }

        // ── Strategia: z flagi (CI) lub z promptu (interaktywny) ────────────
        const isCi = opts.strategy !== undefined;
        let strategy: 'relocate' | 'rebuild' | 'remove' | 'cancel';

        if (isCi) {
          const s = opts.strategy ?? '';
          if (
            s !== 'relocate' &&
            s !== 'rebuild' &&
            s !== 'remove' &&
            s !== 'cancel'
          ) {
            error(fmt('provider_remove_strategy_invalid', s));
            throw new CommandAbort();
          }
          strategy = s;
        } else {
          const ans = await promptWithRawMode<{
            strategy: 'relocate' | 'rebuild' | 'remove' | 'cancel';
          }>([
            {
              type: 'rawlist',
              name: 'strategy',
              message: t('provider_remove_strategy_prompt'),
              choices: [
                {
                  name: t('provider_remove_strategy_relocate'),
                  value: 'relocate',
                },
                {
                  name: t('provider_remove_strategy_rebuild'),
                  value: 'rebuild',
                },
                {
                  name: t('provider_remove_strategy_remove'),
                  value: 'remove',
                },
                { name: t('provider_remove_strategy_cancel'), value: 'cancel' },
              ],
            },
          ]);
          strategy = ans.strategy;
        }

        if (strategy === 'cancel') {
          console.log(t('cancelled'));
          return;
        }

        let password = opts.password;
        let newConnectionConfig: Record<string, unknown> | undefined;
        let relocateNewType: string | undefined;
        let targetProviderId: string | undefined;
        let rebuildScope: 'all' | 'latest' = 'all';

        /**
         * Parses "type:path" format (e.g. "local:D:\foo") from --new-path.
         * Single-letter prefixes (Windows drive letters like "D:") are not treated
         * as type — only identifiers with 2+ lowercase chars qualify.
         */
        function parseNewPath(raw: string): { path: string; type?: string } {
          const colonIdx = raw.indexOf(':');
          if (colonIdx > 1) {
            const prefix = raw.slice(0, colonIdx);
            if (/^[a-z][a-z0-9-]+$/.test(prefix)) {
              return { path: raw.slice(colonIdx + 1), type: prefix };
            }
          }
          return { path: raw };
        }

        if (strategy === 'relocate') {
          if (isCi) {
            if (!opts.newPath?.trim()) {
              error(t('provider_remove_new_path_required'));
              throw new CommandAbort();
            }
            const parsed = parseNewPath(opts.newPath.trim());
            newConnectionConfig = { path: parsed.path };
            relocateNewType = opts.newType?.trim() ?? parsed.type;
          } else {
            const { newPath } = await promptWithRawMode<{ newPath: string }>([
              {
                type: 'input',
                name: 'newPath',
                message: t('provider_remove_new_path_prompt'),
                validate: (v: string) => (v.trim() ? true : t('path_required')),
              },
            ]);
            const parsed = parseNewPath(newPath.trim());
            newConnectionConfig = { path: parsed.path };
            relocateNewType = opts.newType?.trim() ?? parsed.type;
          }

          if (config.encryption.enabled && !password) {
            password = await io.askSecret(
              t('provider_remove_enc_password_relocate'),
            );
          }
        } else if (strategy === 'rebuild') {
          if (config.encryption.enabled && !password) {
            password = await io.askSecret(
              t('provider_remove_enc_password_rebuild'),
            );
          }

          if (isCi) {
            const sc = opts.scope ?? 'all';
            if (sc !== 'all' && sc !== 'latest') {
              error(fmt('provider_remove_scope_invalid', sc));
              throw new CommandAbort();
            }
            rebuildScope = sc;

            if (!opts.target?.trim()) {
              error(t('provider_remove_target_required'));
              throw new CommandAbort();
            }

            if (opts.newPath?.trim()) {
              // New provider: --target is ID, --new-path is path
              const newId = opts.target.trim();
              if (config.providers.some((p) => p.id === newId)) {
                error(fmt('provider_add_exists', newId));
                throw new CommandAbort();
              }
              const parsed = parseNewPath(opts.newPath.trim());
              const newType = opts.newType?.trim() ?? parsed.type ?? 'local';
              const np: ProviderConfig = {
                id: newId,
                type: newType,
                config: { path: parsed.path },
              };
              config.providers.push(np);
              await writeConfig(rootDir, config);
              targetProviderId = newId;
            } else {
              const otherProviders = config.providers.filter(
                (p) => p.id !== providerId,
              );
              if (!otherProviders.some((p) => p.id === opts.target?.trim())) {
                error(fmt('provider_remove_target_invalid', opts.target ?? ''));
                throw new CommandAbort();
              }
              targetProviderId = opts.target.trim();
            }
          } else {
            const { scope } = await promptWithRawMode<{
              scope: 'all' | 'latest';
            }>([
              {
                type: 'rawlist',
                name: 'scope',
                message: t('provider_remove_rebuild_scope_prompt'),
                choices: [
                  {
                    name: t('provider_remove_rebuild_all'),
                    value: 'all',
                  },
                  {
                    name: t('provider_remove_rebuild_latest'),
                    value: 'latest',
                  },
                ],
              },
            ]);
            rebuildScope = scope;

            const NEW_LOC = '__new_location__';
            const otherProviders = config.providers
              .filter((p) => p.id !== providerId)
              .map((p) => p.id);

            const targetChoices: Array<
              string | { name: string; value: string }
            > = [
              ...otherProviders,
              {
                name: t('provider_remove_rebuild_new_location'),
                value: NEW_LOC,
              },
            ];

            const { targetId } = await promptWithRawMode<{ targetId: string }>([
              {
                type: 'rawlist',
                name: 'targetId',
                message: t('provider_remove_target_prompt'),
                choices: targetChoices,
              },
            ]);

            if (targetId === NEW_LOC) {
              targetProviderId = await promptNewProvider(config, rootDir);
            } else {
              targetProviderId = targetId;
            }
          }
        } else if (strategy === 'remove') {
          if (isCi) {
            if (!opts.yes) {
              error(t('provider_remove_yes_required'));
              throw new CommandAbort();
            }
          } else {
            const { confirmed } = await promptWithRawMode<{
              confirmed: boolean;
            }>([
              {
                type: 'confirm',
                name: 'confirmed',
                message: chalk.yellow(
                  fmt('provider_remove_confirm', providerId),
                ),
                default: false,
              },
            ]);
            if (!confirmed) {
              console.log(t('cancelled'));
              return;
            }
          }
        }

        try {
          await removeProvider(rootDir, providerId, {
            strategy,
            ...(newConnectionConfig !== undefined
              ? { newConnectionConfig }
              : {}),
            ...(relocateNewType !== undefined
              ? { newType: relocateNewType }
              : {}),
            ...(targetProviderId !== undefined ? { targetProviderId } : {}),
            rebuildScope,
            ...(password !== undefined ? { password } : {}),
            io,
          });

          if (strategy === 'remove') {
            success(fmt('provider_remove_success', providerId));
            info(t('provider_remove_next_steps'));
            info(t('provider_remove_next_step_1'));
            info(t('provider_remove_next_step_2'));
            info(t('provider_remove_next_step_3'));
          } else if (strategy === 'relocate') {
            success(fmt('provider_relocate_success', providerId));
          } else {
            success(fmt('provider_rebuild_success', providerId));
          }
        } catch (err) {
          if (err instanceof AbortPromptError) throw err;
          if (err instanceof ExitPromptError) throw err;
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}

/**
 * Prompts for new provider details (name, type, path), adds it to config,
 * and returns the new provider's ID.
 *
 * @param config - Current vault config (mutated: new provider is pushed)
 * @param rootDir - Vault root directory (for writing updated config)
 * @returns The new provider's ID
 */
async function promptNewProvider(
  config: VaultConfig,
  rootDir: string,
): Promise<string> {
  const { newId } = await promptWithRawMode<{ newId: string }>([
    {
      type: 'input',
      name: 'newId',
      message: t('provider_add_name_prompt'),
      validate: (v: string) => {
        if (!v.trim()) return t('provider_add_name_required');
        if (config.providers.some((p) => p.id === v.trim()))
          return fmt('provider_add_exists', v);
        return true;
      },
    },
  ]);

  const typeAns = await promptWithRawMode<{ type: string }>([
    {
      type: 'rawlist',
      name: 'type',
      message: t('provider_add_type_prompt'),
      choices: ['local'],
    },
  ]);

  let providerConfig: Record<string, unknown> = {};
  if (typeAns.type === 'local') {
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

  const np: ProviderConfig = {
    id: newId.trim(),
    type: typeAns.type,
    config: providerConfig,
  };
  config.providers.push(np);
  await writeConfig(rootDir, config);
  return newId.trim();
}
