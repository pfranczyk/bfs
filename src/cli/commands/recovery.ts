import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry } from '../../providers/provider.js';
import { recover } from '../../vault/recovery.js';
import { resolveCwd } from '../cwd.js';
import { parseRecoveryBootstrapSpec } from '../parse-provider-spec.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, formatHealth, success, table } from '../ui.js';

/**
 * Registers the `bfs recovery` command on the given Commander program.
 * Rebuilds .bfs/ (config, manifests, state) from remote providers.
 * Does NOT restore files — use `bfs pull` afterwards.
 *
 * Two execution modes:
 *  - **Non-interactive (CI):** triggered by `--bootstrap`. Adapter flags are
 *    forwarded verbatim to `StorageProvider.configureFromFlags()` — same
 *    grammar as `bfs init --ci` adapter-flags. Requires `--provider <type>`
 *    and `--name <vaultName>`.
 *  - **Interactive:** without `--bootstrap`. Falls back to the provider's
 *    `configureInteractive()` flow (REPL prompts for host/user/password/etc).
 *
 * Examples:
 *   bfs recovery --provider local --name picture \
 *     --bootstrap "--path /mnt/usb"
 *   bfs recovery --provider ftp --name temp \
 *     --bootstrap "--host x --user u --password p --path /a"
 *
 * @param program - Commander program to attach the command to
 */
export function registerRecovery(program: Command): void {
  program
    .command('recovery')
    .description(t('cmd_recovery_desc'))
    .option('--provider <type>', t('recovery_opt_provider'))
    .option('--bootstrap <spec>', t('recovery_opt_bootstrap'))
    .option('--name <vaultName>', t('recovery_opt_name'))
    .option('--password <password>', t('recovery_opt_password'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--allow-missing-adapters', t('recovery_opt_allow_missing_adapters'))
    .option('--trust-locations', t('recovery_opt_trust_locations'))
    .action(async (opts: { provider?: string; bootstrap?: string; name?: string; password: string[]; allowMissingAdapters?: boolean; trustLocations?: boolean }, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const io = createCliProviderIO(rootDir);

      // CI mode is gated by --bootstrap. Without it, recovery falls back
      // to the interactive flow (rawlist + configureInteractive) so the
      // REPL experience is unchanged.
      const isCi = opts.bootstrap !== undefined;

      if (isCi) {
        if (!opts.provider) {
          error(t('recovery_ci_provider_required'));
          throw new CommandAbort();
        }
        if (!opts.name?.trim()) {
          error(t('recovery_ci_name_required'));
          throw new CommandAbort();
        }
      }

      // Interactive provider type selection — only when CI mode is off
      // and the user did not pre-select a type.
      if (!opts.provider) {
        const { providerType } = await promptWithRawMode<{ providerType: string }>([
          {
            type: 'rawlist',
            name: 'providerType',
            message: t('recovery_provider_type_prompt'),
            choices: [...providerRegistry.listTypes().map((pt) => ({ name: pt.displayName, value: pt.type })), { name: t('cancel'), value: '__cancel__' }],
          },
        ]);
        if (providerType === '__cancel__') {
          console.log(t('cancelled'));
          return;
        }
        opts.provider = providerType;
      }

      // Branch on isCi — CI delegates flag parsing to the adapter via the
      // shared parse-provider-spec helper; interactive delegates to the
      // adapter's own configureInteractive prompts.
      let connectionConfig: Record<string, unknown>;
      let bootstrapAdapterPackage: Nullable<string>;
      if (isCi) {
        // Type-narrow the optional fields validated above. Re-asserting
        // here keeps Promise.all callbacks and Record<string, unknown>
        // typing happy without non-null assertions.
        const providerType = opts.provider;
        const bootstrapSpec = opts.bootstrap;
        if (providerType === undefined || bootstrapSpec === undefined) {
          throw new Error('invariant: CI fields validated earlier');
        }
        try {
          const parsed = await parseRecoveryBootstrapSpec(bootstrapSpec, providerType, rootDir);
          connectionConfig = parsed.config;
          bootstrapAdapterPackage = parsed.adapterPackage;
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      } else {
        const factory = providerRegistry.getFactory(opts.provider);
        if (!factory) {
          error(fmt('recovery_provider_type_unknown', opts.provider));
          throw new CommandAbort();
        }
        const meta = providerRegistry.getMeta(opts.provider);
        bootstrapAdapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
        const placeholder = factory.create({ id: 'recovery-bootstrap', type: opts.provider, adapterPackage: bootstrapAdapterPackage, config: {} }, io);
        connectionConfig = await placeholder.configureInteractive(io);
      }

      if (!opts.name) {
        const { vaultName } = await promptWithRawMode<{ vaultName: string }>([{ type: 'input', name: 'vaultName', message: t('recovery_vault_name_prompt'), validate: (v: string) => (v.trim() ? true : t('required')) }]);
        opts.name = vaultName.trim();
      }

      const providerType = opts.provider;
      const vaultName = opts.name;

      const spinner = ora(t('recovery_connecting')).start();

      const wrappedIo = {
        ...io,
        info(msg: string): void {
          spinner.text = chalk.dim(msg);
        },
        warn(msg: string): void {
          spinner.stop();
          io.warn(msg);
          spinner.start();
        },
        progress(label: string, percent: number): void {
          spinner.text = `${label} ${chalk.dim(`${Math.round(percent)}%`)}`;
        },
        async ask(prompt: string): Promise<string> {
          spinner.stop();
          const result = await io.ask(prompt);
          spinner.start();
          return result;
        },
        async askSecret(prompt: string): Promise<string> {
          spinner.stop();
          const result = await io.askSecret(prompt);
          spinner.start();
          return result;
        },
        async confirm(message: string): Promise<boolean> {
          spinner.stop();
          const result = await io.confirm(message);
          spinner.start();
          return result;
        },
        async choose(message: string, options: string[]): Promise<string> {
          spinner.stop();
          const result = await io.choose(message, options);
          spinner.start();
          return result;
        },
      };

      try {
        // Create and authenticate bootstrap provider
        const bootstrapProviderConfig = { id: `bootstrap-${providerType}`, type: providerType, adapterPackage: bootstrapAdapterPackage, config: connectionConfig };
        const provider = providerRegistry.create(bootstrapProviderConfig, wrappedIo);
        await provider.authenticate();
        provider.setVaultName(vaultName);

        spinner.text = t('recovery_scanning');

        // Reuse the operator's bootstrap credentials for sibling providers that
        // share them — seeds the recovery input pool so they connect without an
        // extra prompt (a stripped vault keeps no transport secret in headers).
        const bootstrapInputs: Record<string, string> = {};
        for (const field of provider.getSecretFields()) {
          const value = connectionConfig[field];
          if (typeof value === 'string' && value.length > 0) bootstrapInputs[field] = value;
        }

        const report = await recover(rootDir, {
          vaultName,
          provider,
          ...(opts.password.length > 0 ? { passwords: opts.password } : {}),
          ...(Object.keys(bootstrapInputs).length > 0 ? { bootstrapInputs } : {}),
          ...(opts.allowMissingAdapters === true ? { allowMissingAdapters: true } : {}),
          ...(opts.trustLocations === true ? { trustLocations: true } : {}),
          io: wrappedIo,
        });

        spinner.stop();

        console.log(chalk.bold(fmt('recovery_rebuilt', String(report.manifests_rebuilt))));

        const rows = report.versions.map((v) => [`v${String(v.version).padStart(3, '0')}`, formatHealth(v.health), v.consensus ? chalk.green('✓') : chalk.red('✗')]);

        table([t('recovery_col_version'), t('recovery_col_status'), t('recovery_col_consensus')], rows);
        console.log();
        success(t('recovery_success'));
      } catch (err) {
        if (isPromptCancellation(err)) throw err;
        spinner.fail(t('recovery_failed'));
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
