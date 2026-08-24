import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { PullSkippedError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { pull } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { resolvePassword } from '../password-input.js';
import { isReplMode } from '../repl-context.js';
import { createSpinnerIo } from '../spinner-io.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

/**
 * Registers the `bfs pull` command on the given Commander program.
 *
 * Restores files from the backup configuration in the working directory:
 *   bfs pull               - restore latest_version
 *   bfs pull --version 5   - restore version 5
 *
 * A directory without `.bfs/config.json` is refused and pointed at `bfs recovery`;
 * `--provider`, `--path` and `--name` are accepted on the command line but do not
 * reach `pull()`.
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
    .option('--password-file <path>', t('pull_opt_password_file'))
    .option('--provider <type>', t('pull_opt_provider'))
    .option('--path <path>', t('pull_opt_path'))
    .option('--name <vaultName>', t('pull_opt_name'))
    .option('--cache', t('pull_opt_cache'))
    .option('--temp-dir <path>', t('opt_temp_dir_desc'))
    .option('--cache-dir <path>', t('opt_cache_dir_desc'))
    .option('--allow-missing-adapters', t('pull_opt_allow_missing_adapters'))
    .action(
      async (
        opts: {
          version?: string;
          force?: boolean;
          yes?: boolean;
          password?: string;
          passwordFile?: string;
          provider?: string;
          path?: string;
          name?: string;
          cache?: boolean;
          tempDir?: string;
          cacheDir?: string;
          allowMissingAdapters?: boolean;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO(rootDir, isCiRun(cmd) ? false : undefined);
        const wrappedIo = createSpinnerIo(io, spinner);

        const version = opts.version ? parseInt(opts.version, 10) : undefined;

        // Before the spinner: an unreadable password file is the operator's own
        // typo, not a failure of the restore.
        let password: string | undefined;
        try {
          password = await resolvePassword(opts.password, opts.passwordFile !== undefined ? [opts.passwordFile] : []);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }

        spinner.start(t('pull_preparing'));

        try {
          await pull(rootDir, {
            ...(version !== undefined ? { version } : {}),
            ...(opts.force !== undefined ? { force: opts.force } : {}),
            ...(opts.yes ? { yes: true } : {}),
            ...(password !== undefined ? { password } : {}),
            ...(opts.tempDir !== undefined ? { tempDir: opts.tempDir } : {}),
            ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
            ...(opts.allowMissingAdapters === true ? { allowMissingAdapters: true } : {}),
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
