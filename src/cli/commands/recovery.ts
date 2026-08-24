import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry } from '../../providers/provider.js';
import type { ProviderIO, StorageProvider } from '../../types/index.js';
import { recover } from '../../vault/recovery.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { parseRecoveryBootstrapSpec } from '../parse-provider-spec.js';
import { readPasswordFiles } from '../password-input.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { createSpinnerIo } from '../spinner-io.js';
import { CommandAbort, error, formatHealth, success, table } from '../ui.js';

interface RecoveryOpts {
  provider?: string;
  bootstrap?: string;
  name?: string;
  password: string[];
  passwordFile: string[];
  allowMissingAdapters?: boolean;
  trustLocations?: boolean;
}

/**
 * Registers the `bfs recovery` command on the given Commander program.
 * Rebuilds .bfs/ (config, manifests, state) from remote providers.
 * Does NOT restore files - use `bfs pull` afterwards.
 *
 * Where the first storage is comes either from `--bootstrap "<adapter-flags>"`
 * (forwarded verbatim to `StorageProvider.configureFromFlags()`, same grammar as
 * `bfs init --ci` adapter-flags, and requiring `--provider` and `--name`), or -
 * without it - from the provider's own `configureInteractive()` prompts.
 *
 * That choice is about data, not about mode: everything else recovery needs (the
 * backup password, approval of each host a secret is about to reach, secrets
 * stripped from the headers) is still collected interactively. A run that must
 * not be asked anything declares `bfs --ci`, and then an incomplete command
 * fails instead of asking.
 *
 * Examples:
 *   bfs recovery --provider local --name picture \
 *     --bootstrap "--path /mnt/usb"
 *   bfs --ci recovery --provider ftp --name temp --password-file ./pw \
 *     --bootstrap "--host x --user u --password p --path /a" --trust-locations
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
    .option('--password-file <path>', t('recovery_opt_password_file'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--allow-missing-adapters', t('recovery_opt_allow_missing_adapters'))
    .option('--trust-locations', t('recovery_opt_trust_locations'))
    .action(async (opts: RecoveryOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      // --bootstrap says where the first storage is, not that nobody is watching:
      // it replaces the prompts that collect that one provider's settings, and
      // nothing else. Recovering a machine is an operator's job - the password of
      // an encrypted backup, the host each secret is about to reach, the secrets
      // stripped from the headers are all still asked for when there is a
      // terminal. A run that must not be asked anything says so with --ci.
      const hasBootstrapSpec = opts.bootstrap !== undefined;
      const isCi = isCiRun(cmd);
      const io = createCliProviderIO(rootDir, isCi ? false : undefined);
      // Without a bootstrap spec the command asks the operator which adapter to
      // start from and where - questions a `--ci` run cannot answer, and cannot
      // be answered for it later either. Refuse on the command line instead.
      if (isCi && !hasBootstrapSpec) {
        error(t('recovery_ci_bootstrap_required'));
        throw new CommandAbort();
      }
      if (hasBootstrapSpec) {
        _validateCiRecoveryOpts(opts);
      }

      const providerType = await _resolveProviderType(opts.provider);
      if (providerType === null) {
        console.log(t('cancelled'));
        return;
      }

      const { connectionConfig, bootstrapAdapterPackage } = await _resolveConnectionConfig({ providerType, bootstrapSpec: opts.bootstrap, io });
      const vaultName = await _resolveRecoveryVaultName(opts.name);

      // A pool, not a single value: versions of one backup may carry different
      // passwords, so a file adds to what --password supplied instead of
      // replacing it. Read before the spinner starts - a bad file is the
      // operator's typo, not a failure of the recovery.
      let passwords: string[];
      try {
        passwords = [...opts.password, ...(await readPasswordFiles(opts.passwordFile))];
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }

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
          ...(passwords.length > 0 ? { passwords } : {}),
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

// --- Section resolvers (private) -------------------------------------------------

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
async function _resolveConnectionConfig(args: { providerType: string; bootstrapSpec: string | undefined; io: ProviderIO }): Promise<{ connectionConfig: Record<string, unknown>; bootstrapAdapterPackage: Nullable<string> }> {
  const { providerType, bootstrapSpec, io } = args;
  if (bootstrapSpec !== undefined) {
    try {
      const parsed = await parseRecoveryBootstrapSpec(bootstrapSpec, providerType, io);
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
 * them - seeds the recovery input pool so they connect without an extra prompt
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
  const rows = report.versions.map((v) => [`v${String(v.version).padStart(3, '0')}`, formatHealth(v.health), v.consensus ? chalk.green('OK') : chalk.red('X')]);
  table([t('recovery_col_version'), t('recovery_col_status'), t('recovery_col_consensus')], rows);
  console.log();
  // A run that skipped a version cannot close by pointing at "the latest": that
  // one is exactly what stayed sealed. Name the newest version this directory can
  // actually restore, so the closing line is a command that works.
  if (report.unrecovered_versions.length > 0 && report.versions.length > 0) {
    const newest = Math.max(...report.versions.map((v) => v.version));
    success(fmt('recovery_success_partial', String(newest), report.unrecovered_versions.map((v) => `v${String(v).padStart(3, '0')}`).join(', ')));
    return;
  }
  success(t('recovery_success'));
}
