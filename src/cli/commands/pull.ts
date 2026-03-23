import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { pull } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, success } from '../ui.js';

/**
 * Registers the `bfs pull` command on the given Commander program.
 *
 * Mode A (existing .bfs/):
 *   bfs pull               — restore latest_version
 *   bfs pull --version 5   — restore version 5
 *
 * Mode B (no .bfs/ — quick recovery):
 *   bfs pull --provider local --path /backup --name picture [--version 5]
 *   bfs pull --provider ssh   --path user@192.168.1.10/backup/ --name picture
 *   bfs pull --provider ftp   --path user@192.168.1.10/backup/ --name picture
 *   --path format: [user@host/]basePath — CLI parses user and host before passing to provider.
 *
 * @param program - Commander program to attach the command to
 */
export function registerPull(program: Command): void {
  program
    .command('pull')
    .description(t('cmd_pull_desc'))
    .option('--version <n>', 'Version number to restore (default: latest)')
    .option('--force', 'Overwrite directory without confirmation')
    .option(
      '--password <password>',
      'Decryption password (skips interactive prompt)',
    )
    .option('--provider <type>', 'Provider type (e.g. local, ssh, ftp)')
    .option(
      '--path <path>',
      'Provider base path; for remote: user@host/basePath',
    )
    .option('--name <vaultName>', 'Vault name (subfolder on the provider)')
    .action(
      async (
        opts: {
          version?: string;
          force?: boolean;
          password?: string;
          provider?: string;
          path?: string;
          name?: string;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO();

        // Wrap io: info/progress update spinner text; interactive methods pause it
        const wrappedIo = {
          ...io,
          info(msg: string): void {
            spinner.text = chalk.dim(msg);
          },
          progress(label: string, percent: number): void {
            spinner.text = `${label} ${chalk.dim(`${Math.round(percent)}%`)}`;
          },
          async confirm(message: string): Promise<boolean> {
            const wasSpinning = spinner.isSpinning;
            spinner.stop();
            const result = await io.confirm(message);
            if (wasSpinning) spinner.start();
            return result;
          },
          async ask(message: string): Promise<string> {
            const wasSpinning = spinner.isSpinning;
            spinner.stop();
            const result = await io.ask(message);
            if (wasSpinning) spinner.start();
            return result;
          },
          async askSecret(message: string): Promise<string> {
            const wasSpinning = spinner.isSpinning;
            spinner.stop();
            const result = await io.askSecret(message);
            if (wasSpinning) spinner.start();
            return result;
          },
          async choose(message: string, options: string[]): Promise<string> {
            const wasSpinning = spinner.isSpinning;
            spinner.stop();
            const result = await io.choose(message, options);
            if (wasSpinning) spinner.start();
            return result;
          },
          warn(msg: string): void {
            const wasSpinning = spinner.isSpinning;
            if (wasSpinning) spinner.stop();
            io.warn(msg);
            if (wasSpinning) spinner.start();
          },
        };

        // Mode B: no .bfs/, requires --provider --path --name
        // Mode A: standard (with .bfs/)
        // vault-manager.pull handles both modes transparently
        const version = opts.version ? parseInt(opts.version, 10) : undefined;

        spinner.start(t('pull_preparing'));

        try {
          await pull(rootDir, {
            ...(version !== undefined ? { version } : {}),
            ...(opts.force !== undefined ? { force: opts.force } : {}),
            ...(opts.password !== undefined ? { password: opts.password } : {}),
            io: wrappedIo,
          });
          spinner.succeed(t('pull_completed'));
          success(t('pull_success'));
        } catch (err) {
          spinner.fail(t('pull_failed'));
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
