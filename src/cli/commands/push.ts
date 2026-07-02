import chalk from 'chalk';
import type { Command } from 'commander';
import ora from 'ora';
import { LockConcurrentActiveError, LockPartialStatePushError, PushCacheNoLockError, PushCacheUnavailableError, PushDriftError, PushSkippedError } from '../../core/errors.js';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { PushMode, VersionHealth } from '../../types/index.js';
import { _formatDriftList } from '../../vault/push-pipeline.js';
import { push } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { isReplMode } from '../repl-context.js';
import { createSpinnerIo } from '../spinner-io.js';
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
    .option('--temp-dir <path>', t('opt_temp_dir_desc'))
    .option('--cache-dir <path>', t('opt_cache_dir_desc'))
    .option('--max-ram <mb>', t('push_opt_max_ram'))
    .option('--no-compress', t('push_opt_no_compress'))
    .option('--compress', t('push_opt_compress'))
    .option('--allow-drift', t('push_opt_allow_drift'))
    .action(
      async (
        opts: {
          new?: boolean;
          overwrite?: boolean;
          password?: string;
          cache?: boolean;
          tempDir?: string;
          cacheDir?: string;
          maxRam?: string;
          /** Commander: false when --no-compress, true when --compress, true by default. */
          compress?: boolean;
          allowDrift?: boolean;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        let mode: PushMode.NewVersion | PushMode.Overwrite | undefined;
        if (opts.new) mode = PushMode.NewVersion;
        if (opts.overwrite) mode = PushMode.Overwrite;

        // Detect conflict: both flags explicitly given by the user
        // rawArgs is a JS runtime property not declared in Commander typings
        const parent = cmd.parent as unknown as { rawArgs?: string[] } | null;
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

        const spinner = ora({ color: 'cyan' });
        const io = createCliProviderIO(rootDir);
        const wrappedIo = createSpinnerIo(io, spinner);

        spinner.start(t('push_preparing'));

        try {
          const result = await push(rootDir, {
            ...(mode !== undefined ? { mode } : {}),
            ...(opts.password !== undefined ? { password: opts.password } : {}),
            ...(opts.tempDir !== undefined ? { tempDir: opts.tempDir } : {}),
            ...(opts.cacheDir !== undefined ? { cacheDir: opts.cacheDir } : {}),
            ...(opts.maxRam !== undefined ? { maxRamMb: parseInt(opts.maxRam, 10) } : {}),
            ...(compressOverride !== undefined ? { compressOverride } : {}),
            ...(opts.allowDrift !== undefined ? { allowDrift: opts.allowDrift } : {}),
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
