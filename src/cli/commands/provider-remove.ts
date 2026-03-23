import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { readConfig } from '../../vault/config.js';
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
    .option(
      '--password <password>',
      'Encryption password (for rebuild/relocate strategy)',
    )
    .option(
      '--strategy <strategy>',
      'CI strategy: relocate|rebuild|remove (skip prompt)',
    )
    .option(
      '--new-path <path>',
      'New provider path for relocate strategy; optionally with type prefix: local:/path (CI mode)',
    )
    .option(
      '--new-type <type>',
      'New provider type for relocate strategy (when current type is unknown)',
    )
    .option('--target <id>', 'Target provider for rebuild strategy (CI mode)')
    .option(
      '--scope <scope>',
      'Rebuild scope: all|latest (default: all)',
      'all',
    )
    .option('--yes', 'Skip confirmation for remove strategy (CI mode)')
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
              choices: config.providers.map((p, i) => ({
                name: `[${i}] ${p.id}  (${p.type || '?'})`,
                value: p.id,
              })),
            },
          ]);
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
            error(
              `Invalid strategy: "${s}". Allowed: relocate|rebuild|remove|cancel`,
            );
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
            const otherProviders = config.providers.filter(
              (p) => p.id !== providerId,
            );
            if (!otherProviders.some((p) => p.id === opts.target?.trim())) {
              error(fmt('provider_remove_target_invalid', opts.target ?? ''));
              throw new CommandAbort();
            }
            targetProviderId = opts.target.trim();
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

            const otherProviders = config.providers
              .filter((p) => p.id !== providerId)
              .map((p) => p.id);

            if (otherProviders.length === 0) {
              error(t('provider_remove_no_other_providers'));
              throw new CommandAbort();
            }

            const { targetId } = await promptWithRawMode<{ targetId: string }>([
              {
                type: 'rawlist',
                name: 'targetId',
                message: t('provider_remove_target_prompt'),
                choices: otherProviders,
              },
            ]);
            targetProviderId = targetId;
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
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
