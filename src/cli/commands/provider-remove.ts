import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import { BfsError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../../providers/provider.js';
import type { CliProviderInput, ProviderConfig, ProviderIO, VaultConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { listVersions, removeProvider } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

interface ProviderRemoveOpts {
  password?: string;
  strategy?: string;
  newType?: string;
  target?: string;
  scope?: string;
  yes?: boolean;
}

/**
 * Registers the `bfs provider remove <id>` command.
 *
 * CLI surface mirrors `bfs provider add --ci`: BFS recognizes a fixed set
 * of flags (`--strategy`, `--new-type`, `--target`, `--scope`, `--yes`,
 * `--password`); every other CLI token flows verbatim to the provider via
 * `CliProviderInput.rawArgs`. Strategies `relocate` and
 * `rebuild`-new-target delegate building the new connection config to the
 * adapter through `configureFromFlags` / `configureInteractive`.
 *
 * Shows impact on versions, asks for strategy (relocate/rebuild/remove),
 * and applies the chosen strategy via vault-manager.removeProvider().
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderRemove(providerCmd: Command): void {
  providerCmd
    .command('remove [id]')
    .description(t('cmd_provider_remove_desc'))
    // allowUnknownOption / allowExcessArguments: adapter-specific flags
    // (e.g. --config-file, --private-key) pass through as cmd.args → rawArgs.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--password <password>', t('provider_remove_opt_password'))
    .option('--strategy <strategy>', t('provider_remove_opt_strategy'))
    .option('--new-type <type>', t('provider_remove_opt_new_type'))
    .option('--target <id>', t('provider_remove_opt_target'))
    .option('--scope <scope>', t('provider_remove_opt_scope'), 'all')
    .option('--yes', t('provider_remove_opt_yes'))
    .action(async (providerId: string | undefined, opts: ProviderRemoveOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const io = createCliProviderIO(rootDir);

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
          { type: 'rawlist', name: 'chosen', message: t('provider_remove_prompt'), choices: [...config.providers.map((p, i) => ({ name: `[${i}] ${p.id}  (${p.type || '?'})`, value: p.id })), { name: t('cancel'), value: '__cancel__' }] },
        ]);
        if (chosen === '__cancel__') {
          console.log(t('cancelled'));
          return;
        }
        providerId = chosen;
      }

      // Accept numeric index (from `provider list`) or string ID
      const idx = Number(providerId);
      if (!Number.isNaN(idx) && Number.isInteger(idx) && config.providers[idx]) {
        providerId = config.providers[idx].id;
      }

      const providerExists = config.providers.some((p) => p.id === providerId);
      if (!providerExists) {
        error(fmt('provider_remove_not_found', providerId));
        throw new CommandAbort();
      }

      // Show impact on versions
      const manifests = await listVersions(rootDir);
      const affectedVersions = manifests.filter((m) => m.shards.some((s) => s.provider_id === providerId));

      if (affectedVersions.length > 0) {
        warn(fmt('provider_remove_impact', providerId, String(affectedVersions.length)));
        for (const m of affectedVersions) {
          const shardIdx = m.shards.find((s) => s.provider_id === providerId)?.shard_index ?? '?';
          info(`  v${String(m.version).padStart(3, '0')} — shard_${shardIdx} ${chalk.dim(`(${m.health})`)}`);
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
        if (s !== 'relocate' && s !== 'rebuild' && s !== 'remove' && s !== 'cancel') {
          error(fmt('provider_remove_strategy_invalid', s));
          throw new CommandAbort();
        }
        strategy = s;
      } else {
        const ans = await promptWithRawMode<{ strategy: 'relocate' | 'rebuild' | 'remove' | 'cancel' }>([
          {
            type: 'rawlist',
            name: 'strategy',
            message: t('provider_remove_strategy_prompt'),
            choices: [
              { name: t('provider_remove_strategy_relocate'), value: 'relocate' },
              { name: t('provider_remove_strategy_rebuild'), value: 'rebuild' },
              { name: t('provider_remove_strategy_remove'), value: 'remove' },
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

      switch (strategy) {
        case 'relocate': {
          const existingProvider = config.providers.find((p) => p.id === providerId);
          if (!existingProvider) {
            // Unreachable: providerExists check above, but narrows for TS.
            throw new BfsError('invariant: provider existence verified earlier');
          }

          const resolvedType = isCi ? (opts.newType?.trim() ?? existingProvider.type) : await promptTypeChoice(existingProvider.type);
          const factory = providerRegistry.getFactory(resolvedType);
          if (!factory) {
            error(fmt('provider_type_unknown', resolvedType));
            throw new CommandAbort();
          }
          const meta = providerRegistry.getMeta(resolvedType);
          const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
          const placeholder = factory.create({ id: providerId, type: resolvedType, adapterPackage, config: {} }, io);

          try {
            if (isCi) {
              const input: CliProviderInput = { name: providerId, rawArgs: extractAdapterArgs(cmd) };
              newConnectionConfig = await placeholder.configureFromFlags(input);
            } else {
              newConnectionConfig = await placeholder.configureInteractive(io);
            }
          } catch (err) {
            error(err instanceof Error ? err.message : String(err));
            throw new CommandAbort();
          }

          const errors = placeholder.validateConfig(newConnectionConfig);
          if (errors.length > 0) {
            error(fmt('provider_remove_config_invalid', errors.join('; ')));
            throw new CommandAbort();
          }

          relocateNewType = resolvedType === existingProvider.type ? undefined : resolvedType;

          if (config.encryption.enabled && !password) {
            password = await io.askSecret(t('provider_remove_enc_password_relocate'));
          }
          break;
        }
        case 'rebuild': {
          if (config.encryption.enabled && !password) {
            password = await io.askSecret(t('provider_remove_enc_password_rebuild'));
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
            const targetId = opts.target.trim();
            const targetExists = config.providers.some((p) => p.id === targetId);

            if (targetExists) {
              // Existing target — must differ from the provider being removed.
              if (targetId === providerId) {
                error(fmt('provider_remove_target_invalid', targetId));
                throw new CommandAbort();
              }
              targetProviderId = targetId;
            } else {
              // New target — BFS needs --new-type to know which adapter to
              // instantiate. Adapter-specific flags ride along in rawArgs.
              try {
                validateProviderId(targetId);
              } catch (err) {
                error(err instanceof Error ? err.message : String(err));
                throw new CommandAbort();
              }
              const newType = opts.newType?.trim();
              if (!newType) {
                error(t('provider_remove_new_type_required'));
                throw new CommandAbort();
              }
              const newFactory = providerRegistry.getFactory(newType);
              if (!newFactory) {
                error(fmt('provider_type_unknown', newType));
                throw new CommandAbort();
              }
              const newMeta = providerRegistry.getMeta(newType);
              const newAdapterPackage = newMeta ? `${newMeta.packageName}@${newMeta.packageVersion}` : null;
              const placeholder = newFactory.create({ id: targetId, type: newType, adapterPackage: newAdapterPackage, config: {} }, io);
              let providerConfig: Record<string, unknown>;
              try {
                providerConfig = await placeholder.configureFromFlags({ name: targetId, rawArgs: extractAdapterArgs(cmd) });
              } catch (err) {
                error(err instanceof Error ? err.message : String(err));
                throw new CommandAbort();
              }
              const errors = placeholder.validateConfig(providerConfig);
              if (errors.length > 0) {
                error(fmt('provider_remove_config_invalid', errors.join('; ')));
                throw new CommandAbort();
              }
              const np: ProviderConfig = { id: targetId, type: newType, adapterPackage: newAdapterPackage, config: providerConfig };
              config.providers.push(np);
              await writeConfig(rootDir, config);
              targetProviderId = targetId;
            }
          } else {
            const { scope } = await promptWithRawMode<{ scope: 'all' | 'latest' }>([
              {
                type: 'rawlist',
                name: 'scope',
                message: t('provider_remove_rebuild_scope_prompt'),
                choices: [
                  { name: t('provider_remove_rebuild_all'), value: 'all' },
                  { name: t('provider_remove_rebuild_latest'), value: 'latest' },
                ],
              },
            ]);
            rebuildScope = scope;

            const NEW_LOC = '__new_location__';
            const otherProviders = config.providers.filter((p) => p.id !== providerId).map((p) => p.id);

            const targetChoices: Array<string | { name: string; value: string }> = [...otherProviders, { name: t('provider_remove_rebuild_new_location'), value: NEW_LOC }];

            const { targetId } = await promptWithRawMode<{ targetId: string }>([{ type: 'rawlist', name: 'targetId', message: t('provider_remove_target_prompt'), choices: targetChoices }]);

            if (targetId === NEW_LOC) {
              const currentProvider = config.providers.find((p) => p.id === providerId);
              if (!currentProvider) {
                // Unreachable: providerExists check earlier narrows this.
                throw new BfsError('invariant: provider existence verified earlier');
              }
              targetProviderId = await promptNewProvider(config, rootDir, io, currentProvider.type);
            } else {
              targetProviderId = targetId;
            }
          }
          break;
        }
        case 'remove': {
          if (isCi) {
            if (!opts.yes) {
              error(t('provider_remove_yes_required'));
              throw new CommandAbort();
            }
          } else {
            const { confirmed } = await promptWithRawMode<{ confirmed: boolean }>([{ type: 'confirm', name: 'confirmed', message: chalk.yellow(fmt('provider_remove_confirm', providerId)), default: false }]);
            if (!confirmed) {
              console.log(t('cancelled'));
              return;
            }
          }
          break;
        }
      }

      try {
        await removeProvider(rootDir, providerId, {
          strategy,
          ...(newConnectionConfig !== undefined ? { newConnectionConfig } : {}),
          ...(relocateNewType !== undefined ? { newType: relocateNewType } : {}),
          ...(targetProviderId !== undefined ? { targetProviderId } : {}),
          rebuildScope,
          ...(password !== undefined ? { password } : {}),
          io,
        });

        switch (strategy) {
          case 'remove':
            success(fmt('provider_remove_success', providerId));
            info(t('provider_remove_next_steps'));
            info(t('provider_remove_next_step_1'));
            info(t('provider_remove_next_step_2'));
            info(t('provider_remove_next_step_3'));
            break;
          case 'relocate':
            success(fmt('provider_relocate_success', providerId));
            break;
          default:
            success(fmt('provider_rebuild_success', providerId));
            break;
        }
      } catch (err) {
        if (err instanceof AbortPromptError) throw err;
        if (err instanceof ExitPromptError) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}

/**
 * Returns the adapter-flag tokens that should flow through to
 * `CliProviderInput.rawArgs`. With `.allowExcessArguments(true)` enabled,
 * Commander leaves the optional `[id]` positional inside `cmd.args`
 * alongside unknown flags; strip it so the adapter only sees flag-shaped
 * tokens. A leading token that starts with `-` is never a positional.
 */
function extractAdapterArgs(cmd: Command): string[] {
  const args = [...cmd.args];
  if (args.length > 0 && !args[0].startsWith('-')) {
    args.shift();
  }
  return args;
}

/**
 * Confirms whether to change the provider's type, and when confirmed
 * prompts for the new type from the registry. Shared by interactive
 * `relocate` and `rebuild`-new-location flows so the UX is consistent.
 *
 * @param currentType - Type shown as "current" in the confirm prompt;
 *                      also returned verbatim when the user declines.
 * @returns             Either the unchanged `currentType` or the newly
 *                      selected type from the provider registry.
 */
async function promptTypeChoice(currentType: string): Promise<string> {
  const { change } = await promptWithRawMode<{ change: boolean }>([{ type: 'confirm', name: 'change', message: fmt('provider_remove_change_type_confirm', currentType), default: false }]);
  if (!change) return currentType;

  const { newType } = await promptWithRawMode<{ newType: string }>([
    { type: 'rawlist', name: 'newType', message: t('provider_remove_new_type_prompt'), choices: providerRegistry.listTypes().map((pt) => ({ name: pt.displayName, value: pt.type })) },
  ]);
  return newType;
}

/**
 * Prompts for a new provider id + type, lets the adapter collect its own
 * configuration via `configureInteractive`, pushes the resulting entry to
 * the vault config, and returns the new provider's id.
 *
 * Used by `rebuild` interactive flow when the user picks
 * `__new_location__` as the target. Type selection goes through
 * {@link promptTypeChoice} with `fallbackType` (typically the removed
 * provider's type) as the default.
 *
 * @param config       - Current vault config (mutated: new provider is pushed)
 * @param rootDir      - Vault root directory (for writing updated config)
 * @param io           - ProviderIO passed to the adapter's configureInteractive
 * @param fallbackType - Type offered as "keep current" in promptTypeChoice
 * @returns              The new provider's id
 */
async function promptNewProvider(config: VaultConfig, rootDir: string, io: ProviderIO, fallbackType: string): Promise<string> {
  const { newId } = await promptWithRawMode<{ newId: string }>([
    {
      type: 'input',
      name: 'newId',
      message: t('provider_add_name_prompt'),
      validate: (v: string) => {
        const trimmed = v.trim();
        if (!trimmed) return t('provider_add_name_required');
        try {
          validateProviderId(trimmed);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        if (config.providers.some((p) => p.id === trimmed)) return fmt('provider_add_exists', v);
        return true;
      },
    },
  ]);

  const chosenType = await promptTypeChoice(fallbackType);
  const factory = providerRegistry.getFactory(chosenType);
  if (!factory) {
    throw new BfsError(`Unknown provider type: ${chosenType}`);
  }
  const meta = providerRegistry.getMeta(chosenType);
  const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
  const placeholder = factory.create({ id: newId.trim(), type: chosenType, adapterPackage, config: {} }, io);
  const providerConfig = await placeholder.configureInteractive(io);

  const np: ProviderConfig = { id: newId.trim(), type: chosenType, adapterPackage, config: providerConfig };
  config.providers.push(np);
  await writeConfig(rootDir, config);
  return newId.trim();
}
