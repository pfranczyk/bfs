import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { push } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, success } from '../ui.js';

/**
 * Registers the `bfs push` command on the given Commander program.
 *
 * Supported options:
 *   --new        Force new version regardless of push_mode in config
 *   --overwrite  Overwrite current working version
 *   --password   Encryption password (skips interactive prompt)
 *
 * @param program - Commander program to attach the command to
 */
export function registerPush(program: Command): void {
  program
    .command('push')
    .description(t('cmd_push_desc'))
    .option('--new', 'Force a new version')
    .option('--overwrite', 'Overwrite the current version')
    .option(
      '--password <password>',
      'Encryption password (skips interactive prompt)',
    )
    .action(
      async (
        opts: { new?: boolean; overwrite?: boolean; password?: string },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        let mode: 'new_version' | 'overwrite' | undefined;
        if (opts.new) mode = 'new_version';
        if (opts.overwrite) mode = 'overwrite';

        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO();

        // Wrap io: info/progress update spinner; interactive methods pause it first
        const wrappedIo = {
          ...io,
          info(msg: string): void {
            spinner.text = chalk.dim(msg);
          },
          progress(label: string, percent: number): void {
            spinner.text = `${label} ${chalk.dim(`${percent}%`)}`;
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
            io: wrappedIo,
          });
          spinner.succeed(t('push_completed'));
          success(t('push_success'));
        } catch (err) {
          spinner.fail(t('push_failed'));
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
