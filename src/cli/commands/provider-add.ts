import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../../providers/provider.js';
import type { CliProviderInput, ProviderConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, success, warn } from '../ui.js';

interface ProviderAddOpts {
  ci?: boolean;
  name?: string;
  type?: string;
}

/**
 * Registers the `bfs provider add` command.
 *
 * CLI surface is intentionally minimal: BFS recognizes only --ci, --name,
 * and --type. Every other CLI token (e.g. `--config-file`, `--private-key`,
 * `--bucket`) is forwarded verbatim to the provider as `rawArgs`. This keeps
 * BFS blind to provider-specific configuration — adapters define their own
 * flag grammar and decide how to interpret it.
 *
 * Adding a provider changes the N+K scheme — user must run `bfs push`
 * afterwards to rebalance the remote shards.
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderAdd(providerCmd: Command): void {
  providerCmd
    .command('add')
    .description(t('cmd_provider_add_desc'))
    // allowUnknownOption: unrecognized flags pass through to the provider's
    // configureFromFlags via CliProviderInput.rawArgs.
    // allowExcessArguments: Commander otherwise rejects the value tokens that
    // follow an unknown flag (e.g. `--private-key /path`) as excess positional
    // arguments. Together these two calls enable the minimalistic pass-through
    // CLI model described in the provider-cli plan.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--ci', t('provider_add_opt_ci'))
    .option('--name <name>', t('provider_add_opt_name'))
    .option('--type <type>', t('provider_add_opt_type'))
    .action(async (opts: ProviderAddOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const isCi = opts.ci === true;

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      if (!isCi) {
        console.log(fmt('provider_add_current', String(config.providers.length)));
        for (const p of config.providers) {
          console.log(`  - ${p.id} (${p.type})`);
        }
        warn(t('provider_add_warn'));
      }

      let name: string;
      let type: string;

      if (isCi) {
        if (!opts.name?.trim()) {
          error(t('provider_add_name_required'));
          throw new CommandAbort();
        }
        const trimmed = opts.name.trim();
        try {
          validateProviderId(trimmed);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
        if (config.providers.some((p) => p.id === trimmed)) {
          error(fmt('provider_add_exists', opts.name));
          throw new CommandAbort();
        }
        name = trimmed;
        if (!opts.type?.trim()) {
          error(t('provider_add_type_required'));
          throw new CommandAbort();
        }
        type = opts.type.trim();
      } else {
        const ans = await promptWithRawMode<{ name: string }>([
          {
            type: 'input',
            name: 'name',
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
        name = ans.name.trim();

        const typeAns = await promptWithRawMode<{ type: string }>([{ type: 'rawlist', name: 'type', message: t('provider_add_type_prompt'), choices: providerRegistry.listTypes().map((pt) => ({ name: pt.displayName, value: pt.type })) }]);
        type = typeAns.type;
      }

      const factory = providerRegistry.getFactory(type);
      if (!factory) {
        error(fmt('provider_type_unknown', type));
        throw new CommandAbort();
      }

      const io = createCliProviderIO(rootDir);

      // adapterPackage: null for built-in, "pkg@ver" for external adapters
      // that registered with AdapterRegistrationMeta. Persisted in the new
      // provider entry so disaster recovery can reproduce the environment.
      const meta = providerRegistry.getMeta(type);
      const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;

      const placeholder = factory.create({ id: name, type, adapterPackage, config: {} }, io);

      let providerConfig: Record<string, unknown>;
      try {
        if (isCi) {
          const input: CliProviderInput = {
            name,
            // allowUnknownOption(true) parks every token BFS didn't bind
            // (including --config-file, --private-key, …) in cmd.args.
            // The adapter parses them itself.
            rawArgs: [...cmd.args],
          };
          providerConfig = await placeholder.configureFromFlags(input);
        } else {
          providerConfig = await placeholder.configureInteractive(io);
        }
      } catch (err) {
        error(fmt('provider_add_configure_failed', err instanceof Error ? err.message : String(err)));
        throw new CommandAbort();
      }

      const instance = factory.create({ id: name, type, adapterPackage, config: providerConfig }, io);
      const errors = instance.validateConfig(providerConfig);
      if (errors.length > 0) {
        error(fmt('provider_add_validate_failed', errors.join('; ')));
        throw new CommandAbort();
      }

      instance.setVaultName(config.vault_name);
      try {
        await instance.probeConnection();
      } catch (err) {
        error(fmt('provider_add_probe_failed', err instanceof Error ? err.message : String(err)));
        warn(t('provider_add_probe_unsaved'));
        throw new CommandAbort();
      }

      const newProvider: ProviderConfig = { id: name, type, adapterPackage, config: providerConfig };
      config.providers.push(newProvider);

      // Adjust parity shard count: keep data_shards, increase parity by 1
      config.scheme.parity_shards += 1;

      await writeConfig(rootDir, config);
      success(fmt('provider_add_success', newProvider.id, String(config.scheme.data_shards), String(config.scheme.parity_shards)));
    });
}
