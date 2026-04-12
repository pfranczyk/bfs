import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { fmt, t } from '../../i18n/index.js';
import {
  createCliProviderIO,
  createProvider,
} from '../../providers/provider.js';
import { recover } from '../../vault/recovery.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, formatHealth, success, table } from '../ui.js';

/**
 * Registers the `bfs recovery` command on the given Commander program.
 * Rebuilds .bfs/ (config, manifests, state) from remote providers.
 * Does NOT restore files — use `bfs pull` afterwards.
 *
 * Usage:
 *   bfs recovery --provider local --path /mnt/usb-backup --name picture
 *   bfs recovery --provider ssh --path user@192.168.1.10/backup/ --name docs
 *   bfs recovery --provider ftp --path user@192.168.1.10/backup/ --name docs
 *   --path format: [user@host/]basePath — CLI parses user and host before passing to provider.
 *
 * @param program - Commander program to attach the command to
 */
/**
 * Parses a --path value into provider config fields.
 * Local:  "/mnt/usb"            → { path: "/mnt/usb" }
 * Remote: "user@host/base/path" → { user, host, path: "/base/path" }
 */
function parseProviderPath(raw: string): Record<string, string> {
  const atIdx = raw.indexOf('@');
  if (atIdx === -1) return { path: raw };
  const user = raw.slice(0, atIdx);
  const rest = raw.slice(atIdx + 1);
  const slashIdx = rest.indexOf('/');
  if (slashIdx === -1) return { user, host: rest, path: '/' };
  const host = rest.slice(0, slashIdx);
  const path = `/${rest.slice(slashIdx + 1)}`;
  return { user, host, path };
}

export function registerRecovery(program: Command): void {
  program
    .command('recovery')
    .description(t('cmd_recovery_desc'))
    .option('--provider <type>', t('recovery_opt_provider'))
    .option('--path <path>', t('recovery_opt_path'))
    .option('--name <vaultName>', t('recovery_opt_name'))
    .option(
      '--password <password>',
      t('recovery_opt_password'),
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(
      async (
        opts: {
          provider?: string;
          path?: string;
          name?: string;
          password: string[];
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const io = createCliProviderIO();

        // Interactive prompts for missing required fields
        if (!opts.provider) {
          const { providerType } = await promptWithRawMode<{
            providerType: string;
          }>([
            {
              type: 'rawlist',
              name: 'providerType',
              message: t('recovery_provider_type_prompt'),
              choices: ['local', { name: t('cancel'), value: '__cancel__' }],
            },
          ]);
          if (providerType === '__cancel__') {
            console.log(t('cancelled'));
            return;
          }
          opts.provider = providerType;
        }
        if (!opts.path) {
          const { basePath } = await promptWithRawMode<{ basePath: string }>([
            {
              type: 'input',
              name: 'basePath',
              message: t('recovery_path_prompt'),
              validate: (v: string) => (v.trim() ? true : t('required')),
            },
          ]);
          opts.path = basePath.trim();
        }
        if (!opts.name) {
          const { vaultName } = await promptWithRawMode<{ vaultName: string }>([
            {
              type: 'input',
              name: 'vaultName',
              message: t('recovery_vault_name_prompt'),
              validate: (v: string) => (v.trim() ? true : t('required')),
            },
          ]);
          opts.name = vaultName.trim();
        }

        // All three fields are guaranteed non-null after the prompts above
        const providerType = opts.provider as string;
        const basePath = opts.path as string;
        const vaultName = opts.name as string;

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

        // Build bootstrap provider config
        // --path format: [user@host/]basePath  e.g. "alice@192.168.1.10/backup/"
        const connectionConfig: Record<string, unknown> =
          parseProviderPath(basePath);

        try {
          // Create and authenticate bootstrap provider
          const bootstrapProviderConfig = {
            id: `bootstrap-${providerType}`,
            type: providerType,
            config: connectionConfig,
          };
          const provider = createProvider(bootstrapProviderConfig, wrappedIo);
          await provider.authenticate();
          provider.setVaultName(vaultName);

          spinner.text = t('recovery_scanning');

          const report = await recover(rootDir, {
            vaultName,
            provider,
            ...(opts.password.length > 0 ? { passwords: opts.password } : {}),
            io: wrappedIo,
          });

          spinner.stop();

          console.log(
            chalk.bold(
              fmt('recovery_rebuilt', String(report.manifests_rebuilt)),
            ),
          );

          const rows = report.versions.map((v) => [
            `v${String(v.version).padStart(3, '0')}`,
            formatHealth(v.health),
            v.consensus ? chalk.green('✓') : chalk.red('✗'),
          ]);

          table(
            [
              t('recovery_col_version'),
              t('recovery_col_status'),
              t('recovery_col_consensus'),
            ],
            rows,
          );
          console.log();
          success(t('recovery_success'));
        } catch (err) {
          if (err instanceof AbortPromptError) throw err;
          if (err instanceof ExitPromptError) throw err;
          spinner.fail(t('recovery_failed'));
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
