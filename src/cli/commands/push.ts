import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { LockConcurrentActiveError, LockPartialStatePushError, PushCacheCorruptedError, PushCacheNoLockError, PushCacheUnavailableError, PushDriftError, PushExcludedError, PushSkippedError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { PushMode, VersionHealth } from '../../types/index.js';
import { _formatDriftList, _formatExcludedList } from '../../vault/push-pipeline.js';
import { push } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { resolvePassword } from '../password-input.js';
import { isReplMode } from '../repl-context.js';
import { createSpinnerIo } from '../spinner-io.js';
import { CommandAbort, error, info, success, warn } from '../ui.js';

/**
 * Registers the `bfs push` command on the given Commander program.
 *
 * Supported options:
 *   --new        Force new version regardless of push_mode in config
 *   --overwrite  Overwrite current working version
 *   -y, --yes    Pre-consent to the version-switch confirmation
 *   --password       Encryption password (skips interactive prompt)
 *   --password-file  Read that password from a file, keeping it out of argv
 *   --cache          Upload the blob cached from a previous aborted push
 *   --temp-dir, --cache-dir, --max-ram  Override the configured paths / RAM budget
 *   --compress / --no-compress          Override the configured compression
 *   --allow-drift, --allow-excluded     Accept a directory that changed while
 *                                       packing, or entries that cannot be backed up
 *
 * @param program - Commander program to attach the command to
 */
export function registerPush(program: Command): void {
  program
    .command('push')
    .description(t('cmd_push_desc'))
    .option('--new', t('push_opt_new'))
    .option('--overwrite', t('push_opt_overwrite'))
    .option('-y, --yes', t('push_opt_yes'))
    .option('--password <password>', t('push_opt_password'))
    .option('--password-file <path>', t('push_opt_password_file'))
    .option('--cache', t('push_opt_cache'))
    .option('--temp-dir <path>', t('opt_temp_dir_desc'))
    .option('--cache-dir <path>', t('opt_cache_dir_desc'))
    .option('--max-ram <mb>', t('push_opt_max_ram'))
    .option('--no-compress', t('push_opt_no_compress'))
    .option('--compress', t('push_opt_compress'))
    .option('--allow-drift', t('push_opt_allow_drift'))
    .option('--allow-excluded', t('push_opt_allow_excluded'))
    .action(
      async (
        opts: {
          new?: boolean;
          overwrite?: boolean;
          yes?: boolean;
          password?: string;
          passwordFile?: string;
          cache?: boolean;
          tempDir?: string;
          cacheDir?: string;
          maxRam?: string;
          /** Commander: false when --no-compress, true when --compress, true by default. */
          compress?: boolean;
          allowDrift?: boolean;
          allowExcluded?: boolean;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        let mode: PushMode.NewVersion | PushMode.Overwrite | undefined;
        if (opts.new) mode = PushMode.NewVersion;
        if (opts.overwrite) mode = PushMode.Overwrite;

        // Detect conflict: both flags explicitly given by the user
        // rawArgs is a JS runtime property not declared in Commander typings
        const parent = cmd.parent as unknown as Nullable<{ rawArgs?: string[] }>;
        const rawArgs = parent?.rawArgs ?? [];
        const hasCompressFlag = rawArgs.includes('--compress');
        const hasNoCompressFlag = rawArgs.includes('--no-compress');
        if (hasCompressFlag && hasNoCompressFlag) {
          error(t('push_compress_conflict'));
          throw new CommandAbort();
        }

        // compressOverride is set only when the user explicitly passed one of the flags
        const compressSource = cmd.getOptionValueSource('compress');
        const compressOverride: boolean | undefined = compressSource === 'cli' ? opts.compress : undefined;

        // Resolved before the spinner starts: a bad password file is the
        // operator's own typo, and its message should not surface from under a
        // spinner as if it were a failure of the backup itself.
        let password: string | undefined;
        try {
          password = await resolvePassword(opts.password, opts.passwordFile !== undefined ? [opts.passwordFile] : []);
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }

        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO(rootDir, isCiRun(cmd) ? false : undefined);
        const wrappedIo = createSpinnerIo(io, spinner);

        spinner.start(t('push_preparing'));

        try {
          const result = await push(rootDir, {
            ...(mode !== undefined ? { mode } : {}),
            ...(password !== undefined ? { password } : {}),
            ...(opts.tempDir !== undefined ? { tempDir: opts.tempDir } : {}),
            ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
            ...(opts.maxRam !== undefined ? { maxRamMb: parseInt(opts.maxRam, 10) } : {}),
            ...(compressOverride !== undefined ? { compressOverride } : {}),
            ...(opts.allowDrift !== undefined ? { allowDrift: opts.allowDrift } : {}),
            ...(opts.allowExcluded !== undefined ? { allowExcluded: opts.allowExcluded } : {}),
            ...(opts.yes === true ? { yes: true } : {}),
            fromCache: opts.cache ?? false,
            interactive: isReplMode(),
            io: wrappedIo,
          });

          // Total shards expected by the scheme; derived from the result so
          // we never disagree with what push() actually attempted.
          const total = result.uploaded_count + result.failed.length;

          switch (result.health) {
            case VersionHealth.Healthy:
              spinner.succeed(t('push_completed'));
              success(fmt('push_completed_healthy', String(result.version), String(result.uploaded_count), String(total)));
              break;
            case VersionHealth.Degraded:
              spinner.warn(t('push_failed'));
              warn(fmt('push_partial_degraded', String(result.version), String(result.uploaded_count), String(total)));
              throw new CommandAbort();
            case VersionHealth.Damaged:
              spinner.fail(t('push_failed'));
              error(fmt('push_damaged', String(result.version), String(result.uploaded_count), String(total), String(result.version)));
              throw new CommandAbort();
            // VersionHealth.Unknown is never returned by push(); intentionally no default branch.
          }
        } catch (err) {
          // Re-throw CommandAbort so the outer harness sees the exit signal.
          if (err instanceof CommandAbort) throw err;

          if (err instanceof PushCacheNoLockError) {
            spinner.fail(t('push_failed'));
            error(fmt('push_cache_no_lock', err.missing.join(', ')));
            throw new CommandAbort();
          }
          if (err instanceof PushCacheUnavailableError) {
            spinner.fail(t('push_failed'));
            error(t('push_cache_unavailable_in_lock'));
            throw new CommandAbort();
          }
          if (err instanceof PushCacheCorruptedError) {
            spinner.fail(t('push_failed'));
            error(fmt('push_cache_corrupted', err.cachePath));
            throw new CommandAbort();
          }
          if (err instanceof LockConcurrentActiveError) {
            spinner.fail(t('push_failed'));
            error(fmt('lock_concurrent_active', err.operation, String(err.pid), err.started_at));
            throw new CommandAbort();
          }
          if (err instanceof LockPartialStatePushError) {
            spinner.fail(t('push_failed'));
            error(fmt('lock_partial_state_push', String(err.version)));
            throw new CommandAbort();
          }
          if (err instanceof PushDriftError) {
            const { changed, vanished, appeared } = err.drift;
            spinner.fail(t('push_failed'));
            warn(fmt('push_drift_header', String(changed.length + vanished.length + appeared.length)));
            console.log(chalk.yellow(_formatDriftList(err.drift)));
            info(t('push_drift_hint'));
            throw new CommandAbort();
          }
          if (err instanceof PushExcludedError) {
            spinner.fail(t('push_failed'));
            warn(fmt('push_excluded_header', String(err.excluded.length)));
            console.log(chalk.yellow(_formatExcludedList(err.excluded)));
            info(t('push_excluded_hint'));
            throw new CommandAbort(3);
          }
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
