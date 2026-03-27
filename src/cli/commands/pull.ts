import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { PullSkippedError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { pull } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isReplMode } from '../repl-context.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

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
    .option('--version <n>', t('pull_opt_version'))
    .option('--force', t('pull_opt_force'))
    .option('-y, --yes', t('pull_opt_yes'))
    .option('--password <password>', t('pull_opt_password'))
    .option('--provider <type>', t('pull_opt_provider'))
    .option('--path <path>', t('pull_opt_path'))
    .option('--name <vaultName>', t('pull_opt_name'))
    .option('--cache', t('pull_opt_cache'))
    .action(
      async (
        opts: {
          version?: string;
          force?: boolean;
          yes?: boolean;
          password?: string;
          provider?: string;
          path?: string;
          name?: string;
          cache?: boolean;
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
            ...(opts.yes ? { yes: true } : {}),
            ...(opts.password !== undefined ? { password: opts.password } : {}),
            fromCache: opts.cache ?? false,
            interactive: isReplMode(),
            io: wrappedIo,
          });
          spinner.succeed(t('pull_completed'));
          success(t('pull_success'));
        } catch (err) {
          if (err instanceof PullSkippedError) {
            spinner.fail(t('pull_failed'));
            warn(fmt('pull_skipped_header', String(err.skipped.length)));
            for (const s of err.skipped) {
              console.log(chalk.yellow(`  - ${s.path}: ${s.reason}`));
            }
            info(t('pull_cache_hint'));
            throw new CommandAbort();
          }
          spinner.fail(t('pull_failed'));
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
