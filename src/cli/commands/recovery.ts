import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry } from '../../providers/provider.js';
import type { ProviderIO, StorageProvider } from '../../types/index.js';
import { recover } from '../../vault/recovery.js';
import { resolveCwd } from '../cwd.js';
import { parseRecoveryBootstrapSpec } from '../parse-provider-spec.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { createSpinnerIo } from '../spinner-io.js';
import { CommandAbort, error, formatHealth, success, table } from '../ui.js';

interface RecoveryOpts {
  provider?: string;
  bootstrap?: string;
  name?: string;
  password: string[];
  allowMissingAdapters?: boolean;
  trustLocations?: boolean;
}

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
    .action(async (opts: RecoveryOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const io = createCliProviderIO(rootDir);

      // CI mode is gated by --bootstrap. Without it, recovery falls back to the
      // interactive flow (rawlist + configureInteractive) so the REPL is unchanged.
      const isCi = opts.bootstrap !== undefined;
      if (isCi) {
        _validateCiRecoveryOpts(opts);
      }

      const providerType = await _resolveProviderType(opts.provider);
      if (providerType === null) {
        console.log(t('cancelled'));
        return;
      }

      const { connectionConfig, bootstrapAdapterPackage } = await _resolveConnectionConfig({ providerType, bootstrapSpec: opts.bootstrap, rootDir, io });
      const vaultName = await _resolveRecoveryVaultName(opts.name);

      const spinner = ora(t('recovery_connecting')).start();
      const wrappedIo = createSpinnerIo(io, spinner);

      try {
        // Create and authenticate bootstrap provider
        const bootstrapProviderConfig = { id: `bootstrap-${providerType}`, type: providerType, adapterPackage: bootstrapAdapterPackage, config: connectionConfig };
        const provider = providerRegistry.create(bootstrapProviderConfig, wrappedIo);
        await provider.authenticate();
        provider.setVaultName(vaultName);

        spinner.text = t('recovery_scanning');

        const bootstrapInputs = _collectBootstrapInputs(provider, connectionConfig);
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
        _renderRecoveryReport(report);
      } catch (err) {
        if (isPromptCancellation(err)) throw err;
        spinner.fail(t('recovery_failed'));
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}

// ─── Section resolvers (private) ─────────────────────────────────────────────────

/** Validates the flags --bootstrap (CI) contractually requires: --provider and --name. */
function _validateCiRecoveryOpts(opts: RecoveryOpts): void {
  if (!opts.provider) {
    error(t('recovery_ci_provider_required'));
    throw new CommandAbort();
  }
  if (!opts.name?.trim()) {
    error(t('recovery_ci_name_required'));
    throw new CommandAbort();
  }
}

/**
 * Resolves the provider type: the pre-selected `--provider` value, or an
 * interactive rawlist when it is absent. Returns null when the user cancels.
 */
async function _resolveProviderType(provider: string | undefined): Promise<Nullable<string>> {
  if (provider) return provider;
  const { providerType } = await promptWithRawMode<{ providerType: string }>([
    { type: 'rawlist', name: 'providerType', message: t('recovery_provider_type_prompt'), choices: [...providerRegistry.listTypes().map((pt) => ({ name: pt.displayName, value: pt.type })), { name: t('cancel'), value: '__cancel__' }] },
  ]);
  return providerType === '__cancel__' ? null : providerType;
}

/**
 * Resolves the bootstrap connection config. In CI (`bootstrapSpec` present) flag
 * parsing is delegated to the adapter via the shared parse-provider-spec helper;
 * interactively it delegates to the adapter's own configureInteractive prompts.
 */
async function _resolveConnectionConfig(args: { providerType: string; bootstrapSpec: string | undefined; rootDir: string; io: ProviderIO }): Promise<{ connectionConfig: Record<string, unknown>; bootstrapAdapterPackage: Nullable<string> }> {
  const { providerType, bootstrapSpec, rootDir, io } = args;
  if (bootstrapSpec !== undefined) {
    try {
      const parsed = await parseRecoveryBootstrapSpec(bootstrapSpec, providerType, rootDir);
      return { connectionConfig: parsed.config, bootstrapAdapterPackage: parsed.adapterPackage };
    } catch (err) {
      error(err instanceof Error ? err.message : String(err));
      throw new CommandAbort();
    }
  }
  const factory = providerRegistry.getFactory(providerType);
  if (!factory) {
    error(fmt('recovery_provider_type_unknown', providerType));
    throw new CommandAbort();
  }
  const meta = providerRegistry.getMeta(providerType);
  const bootstrapAdapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
  const placeholder = factory.create({ id: 'recovery-bootstrap', type: providerType, adapterPackage: bootstrapAdapterPackage, config: {} }, io);
  return { connectionConfig: await placeholder.configureInteractive(io), bootstrapAdapterPackage };
}

/** Resolves the vault name from --name or an interactive prompt. */
async function _resolveRecoveryVaultName(name: string | undefined): Promise<string> {
  if (name) return name;
  const { vaultName } = await promptWithRawMode<{ vaultName: string }>([{ type: 'input', name: 'vaultName', message: t('recovery_vault_name_prompt'), validate: (v: string) => (v.trim() ? true : t('required')) }]);
  return vaultName.trim();
}

/**
 * Reuses the operator's bootstrap credentials for sibling providers that share
 * them — seeds the recovery input pool so they connect without an extra prompt
 * (a stripped vault keeps no transport secret in headers).
 */
function _collectBootstrapInputs(provider: StorageProvider, connectionConfig: Record<string, unknown>): Record<string, string> {
  const bootstrapInputs: Record<string, string> = {};
  for (const field of provider.getSecretFields()) {
    const value = connectionConfig[field];
    if (typeof value === 'string' && value.length > 0) bootstrapInputs[field] = value;
  }
  return bootstrapInputs;
}

/** Prints the recovery summary table (rebuilt count + per-version health/consensus). */
function _renderRecoveryReport(report: Awaited<ReturnType<typeof recover>>): void {
  console.log(chalk.bold(fmt('recovery_rebuilt', String(report.manifests_rebuilt))));
  const rows = report.versions.map((v) => [`v${String(v.version).padStart(3, '0')}`, formatHealth(v.health), v.consensus ? chalk.green('✓') : chalk.red('✗')]);
  table([t('recovery_col_version'), t('recovery_col_status'), t('recovery_col_consensus')], rows);
  console.log();
  success(t('recovery_success'));
}
