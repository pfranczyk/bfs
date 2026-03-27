import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { PushSkippedError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { PushMode } from '../../types/index.js';
import { push } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isReplMode } from '../repl-context.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

/**
 * Registers the `bfs push` command on the given Commander program.
 *
 * Supported options:
 *   --new        Force new version regardless of push_mode in config
 *   --overwrite  Overwrite current working version
 *   --password   Encryption password (skips interactive prompt)
 *   --cache      Upload the blob cached from a previous aborted push
 *
 * @param program - Commander program to attach the command to
 */
export function registerPush(program: Command): void {
  program
    .command('push')
    .description(t('cmd_push_desc'))
    .option('--new', t('push_opt_new'))
    .option('--overwrite', t('push_opt_overwrite'))
    .option('--password <password>', t('push_opt_password'))
    .option('--cache', t('push_opt_cache'))
    .action(
      async (
        opts: {
          new?: boolean;
          overwrite?: boolean;
          password?: string;
          cache?: boolean;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        let mode: PushMode.NewVersion | PushMode.Overwrite | undefined;
        if (opts.new) mode = PushMode.NewVersion;
        if (opts.overwrite) mode = PushMode.Overwrite;

        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO();

        // Wrap io: info/progress update spinner; interactive methods pause it first
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
        };

        spinner.start(t('push_preparing'));

        try {
          await push(rootDir, {
            ...(mode !== undefined ? { mode } : {}),
            ...(opts.password !== undefined ? { password: opts.password } : {}),
            fromCache: opts.cache ?? false,
            interactive: isReplMode(),
            io: wrappedIo,
          });
          spinner.succeed(t('push_completed'));
          success(t('push_success'));
        } catch (err) {
          if (err instanceof PushSkippedError) {
            spinner.fail(t('push_failed'));
            warn(fmt('push_skipped_header', String(err.skipped.length)));
            for (const s of err.skipped) {
              console.log(chalk.yellow(`  - ${s.path}: ${s.reason}`));
            }
            info(t('push_cache_hint'));
            throw new CommandAbort();
          }
          spinner.fail(t('push_failed'));
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
