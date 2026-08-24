import chalk from 'chalk';
import type { Command } from 'commander';
import { BfsError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../../providers/provider.js';
import type { CliProviderInput, ProviderConfig, ProviderIO, VaultConfig, VersionManifest } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { listVersions, removeProvider } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { resolvePassword } from '../password-input.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

interface ProviderRemoveOpts {
  password?: string;
  passwordFile?: string;
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
 * `--password`, `--password-file`); every other CLI token flows verbatim to the provider via
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
    // (e.g. --config-file, --private-key) pass through as cmd.args -> rawArgs.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--password <password>', t('provider_remove_opt_password'))
    .option('--password-file <path>', t('provider_remove_opt_password_file'))
    .option('--strategy <strategy>', t('provider_remove_opt_strategy'))
    .option('--new-type <type>', t('provider_remove_opt_new_type'))
    .option('--target <id>', t('provider_remove_opt_target'))
    .option('--scope <scope>', t('provider_remove_opt_scope'), 'all')
    .option('--yes', t('provider_remove_opt_yes'))
    .action(async (providerId: string | undefined, opts: ProviderRemoveOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      // --strategy supplies the decision this command would otherwise ask for; it
      // does not declare that nobody is watching. An operator who names the
      // strategy but leaves out the password of an encrypted backup is still
      // asked for it at a terminal. A run that must not be asked anything says
      // so with `bfs --ci`, and then the missing password is an error.
      const hasStrategyFlag = opts.strategy !== undefined;
      const isCi = isCiRun(cmd);
      const io = createCliProviderIO(rootDir, isCi ? false : undefined);

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      // Which storage comes first, because without it the command would open a
      // picker. The rest waits until the name has been resolved and checked: a
      // typo in it should be reported as a typo, not as a flag the operator then
      // adds to a command that was never going to work.
      if (isCi && !providerId) {
        error(t('provider_remove_ci_id_required'));
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

      if (isCi) _assertCiCommandComplete({ opts, config });

      // Show impact on versions
      const manifests = await listVersions(rootDir);
      const affectedVersions = manifests.filter((m) => m.shards.some((s) => s.provider_id === providerId));

      if (affectedVersions.length > 0) {
        warn(fmt('provider_remove_impact', providerId, String(affectedVersions.length)));
        for (const m of affectedVersions) {
          const shardIdx = m.shards.find((s) => s.provider_id === providerId)?.shard_index ?? '?';
          info(`  v${String(m.version).padStart(3, '0')} - shard_${shardIdx} ${chalk.dim(`(${m.health})`)}`);
        }
        console.log();
        info(t('provider_remove_impact_warn'));
        console.log();
      }

      // -- Strategy: from flag (CI) or from prompt (interactive) ------------
      let strategy: 'relocate' | 'rebuild' | 'remove' | 'cancel';

      if (hasStrategyFlag) {
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

      let password: string | undefined;
      try {
        password = await resolvePassword(opts.password, opts.passwordFile !== undefined ? [opts.passwordFile] : []);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
      let newConnectionConfig: Record<string, unknown> | undefined;
      let relocateNewType: string | undefined;
      let targetProviderId: string | undefined;
      let rebuildScope: 'all' | 'latest' = 'all';
      // A brand-new rebuild target must be persisted before removeProvider runs,
      // because the heal path re-reads the config from disk to find it. Remember
      // it so a failed removal does not leave the vault one provider over its
      // scheme, which would refuse every later push, pull and prune.
      let addedTargetProviderId: string | undefined;

      switch (strategy) {
        case 'relocate': {
          const existingProvider = config.providers.find((p) => p.id === providerId);
          if (!existingProvider) {
            // Unreachable: providerExists check above, but narrows for TS.
            throw new BfsError('invariant: provider existence verified earlier');
          }

          const resolvedType = hasStrategyFlag ? (opts.newType?.trim() ?? existingProvider.type) : await promptTypeChoice(existingProvider.type);
          const factory = providerRegistry.getFactory(resolvedType);
          if (!factory) {
            error(fmt('provider_type_unknown', resolvedType));
            throw new CommandAbort();
          }
          const meta = providerRegistry.getMeta(resolvedType);
          const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
          const placeholder = factory.create({ id: providerId, type: resolvedType, adapterPackage, config: {} }, io);

          try {
            if (hasStrategyFlag) {
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

          if (hasStrategyFlag) {
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
              // Existing target - must differ from the provider being removed.
              if (targetId === providerId) {
                error(fmt('provider_remove_target_invalid', targetId));
                throw new CommandAbort();
              }
              targetProviderId = targetId;
            } else {
              // New target - BFS needs --new-type to know which adapter to
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
              addedTargetProviderId = targetId;
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
              addedTargetProviderId = targetProviderId;
            } else {
              targetProviderId = targetId;
            }
          }
          break;
        }
        case 'remove': {
          if (hasStrategyFlag) {
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
            info(t('provider_remove_next_step_4'));
            break;
          case 'relocate':
            success(fmt('provider_relocate_success', providerId));
            break;
          default:
            success(fmt('provider_rebuild_success', providerId));
            break;
        }
      } catch (err) {
        // Withdrawing the target comes before the cancellation re-throw: a
        // rebuild can raise a prompt of its own (a server identity to trust,
        // the post-recovery location gate), and Ctrl+C there leaves the vault
        // one provider over its scheme just as an error does.
        if (addedTargetProviderId !== undefined) {
          await revertAddedTarget(rootDir, { targetId: addedTargetProviderId, removedProviderId: providerId, shardIndexByVersion: shardIndexPerAffectedVersion(affectedVersions, providerId) });
        }
        if (isPromptCancellation(err)) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}

/** What {@link _assertCiCommandComplete} reads to judge a command line. */
interface CiCompletenessInput {
  /** Flags Commander recognised on this invocation. */
  opts: ProviderRemoveOpts;
  /** Vault config, for whether a password is needed at all. */
  config: VaultConfig;
}

/**
 * Rejects an incomplete `--ci` command line before the command does any work.
 *
 * Every piece checked here is one this command would otherwise ask for, and one
 * a run that declared `--ci` can never supply afterwards - so discovering it
 * later means the adapter was configured, and possibly a new storage entry
 * written, only to reach a refusal the command line already implied. The order
 * follows what the operator has to decide: what to do with the data, where it
 * goes, and only then the secret that lets it be re-encrypted. Which storage is
 * settled by the caller before this runs, so a name that does not exist is
 * reported as such rather than as a missing flag.
 *
 * `remove` is deliberately exempt from the password check - it drops the entry
 * without touching a byte, so demanding a secret would turn a complete command
 * line away.
 *
 * @param input - The parsed flags and the vault config
 * @throws CommandAbort when something the run cannot be asked for is missing
 */
function _assertCiCommandComplete(input: CiCompletenessInput): void {
  const { opts, config } = input;
  const strategy = opts.strategy?.trim();
  if (!strategy) {
    error(t('provider_remove_ci_strategy_required'));
    throw new CommandAbort();
  }
  if (strategy !== 'relocate' && strategy !== 'rebuild' && strategy !== 'remove' && strategy !== 'cancel') {
    error(fmt('provider_remove_strategy_invalid', strategy));
    throw new CommandAbort();
  }
  if (strategy === 'remove' && opts.yes !== true) {
    error(t('provider_remove_yes_required'));
    throw new CommandAbort();
  }
  if (strategy === 'rebuild') {
    const scope = opts.scope ?? 'all';
    if (scope !== 'all' && scope !== 'latest') {
      error(fmt('provider_remove_scope_invalid', scope));
      throw new CommandAbort();
    }
    if (!opts.target?.trim()) {
      error(t('provider_remove_target_required'));
      throw new CommandAbort();
    }
  }
  // An empty --password is not a password: resolvePassword would hand it on and
  // the run would fail deeper down with the generic "nobody to ask" message,
  // which is the outcome this guard exists to replace.
  const hasSecret = (opts.password !== undefined && opts.password.length > 0) || opts.passwordFile !== undefined;
  const needsPassword = config.encryption.enabled && (strategy === 'relocate' || strategy === 'rebuild');
  if (needsPassword && !hasSecret) {
    error(t('provider_remove_ci_password_required'));
    throw new CommandAbort();
  }
}

/** Which shard index the provider being removed owns, per version that uses it. */
function shardIndexPerAffectedVersion(manifests: VersionManifest[], providerId: string): Map<number, number> {
  const byVersion = new Map<number, number>();
  for (const m of manifests) {
    const shardIndex = m.shards.find((s) => s.provider_id === providerId)?.shard_index;
    if (shardIndex !== undefined) byVersion.set(m.version, shardIndex);
  }
  return byVersion;
}

/** What {@link revertAddedTarget} needs to tell an unused target from a loaded one. */
interface RevertAddedTargetOptions {
  /** Id of the target this command created and persisted. */
  targetId: string;
  /** Id of the provider the command set out to remove. */
  removedProviderId: string;
  /** Shard index the removed provider owns, per version that uses it. */
  shardIndexByVersion: Map<number, number>;
}

/**
 * Undoes the config entry written for a brand-new rebuild target after the
 * removal that needed it failed.
 *
 * Whether the entry may go is only knowable once the failure has happened:
 * rebuildAllVersions repairs version by version, so it can move some versions
 * onto the target before failing on a later one. Deciding it needs a reading of
 * the manifests taken now, not the one the command opened with - at that moment
 * the target did not exist yet.
 *
 * The question asked of each manifest is narrow on purpose: did the shard the
 * removed provider owned move to the target? An id can carry references from an
 * earlier life - a version repaired only within a `--version` range keeps naming
 * it - and a broader "is this id mentioned anywhere" would read those as freshly
 * rebuilt data and strand the entry the command is meant to withdraw.
 *
 * Anything that cannot be established keeps the entry: a manifest that will not
 * parse right now proves nothing, and once removeProvider has dropped the old
 * provider from the config the removal is past the point where withdrawing the
 * target repairs anything - it would take the vault below its own scheme.
 *
 * @param rootDir - Vault root directory
 * @param options - Target id, removed provider id, and its shard index per version
 */
async function revertAddedTarget(rootDir: string, options: RevertAddedTargetOptions): Promise<void> {
  const { targetId, removedProviderId, shardIndexByVersion } = options;
  const config = await readConfig(rootDir);
  if (!config) return;
  if (!config.providers.some((p) => p.id === removedProviderId)) return;

  const manifests = await listVersions(rootDir);
  for (const [version, shardIndex] of shardIndexByVersion) {
    const manifest = manifests.find((m) => m.version === version);
    if (!manifest || manifest.shards.some((s) => s.shard_index === shardIndex && s.provider_id === targetId)) {
      warn(fmt('provider_remove_target_kept', targetId));
      return;
    }
  }

  await writeConfig(rootDir, { ...config, providers: config.providers.filter((p) => p.id !== targetId) });
  info(fmt('provider_remove_target_reverted', targetId));
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
 * Type selection goes through {@link promptTypeChoice} with `fallbackType`
 * (typically the removed provider's type) as the default.
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
