import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { isEnoent } from '../../core/fs-utils.js';
import { fmt, t } from '../../i18n/index.js';
import { readConfig } from '../../vault/config.js';
import { pushLockPath, repairLockPath } from '../../vault/lockfile.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, info, success } from '../ui.js';

/**
 * Registers the `bfs clear` command on the given Commander program.
 * Deletes the following leftover files from previous interrupted operations:
 *   <cacheDir>/push.blob.pending
 *   <cacheDir>/pull.blob.pending
 *   <rootDir>/.bfs/push.lock
 *   <rootDir>/.bfs/repair.lock
 *
 * Cache directory resolution: --cache-dir flag → config.cache_dir →
 * {rootDir}/.bfs/cache. Per-file info is emitted for every file actually
 * removed. ENOENT is tolerated; any other failure (e.g. EPERM) is rethrown.
 *
 * @param program - Commander program to attach the command to
 */
export function registerClear(program: Command): void {
  program
    .command('clear')
    .description(t('cmd_clear_desc'))
    .option('--cache-dir <path>', t('opt_cache_dir_desc'))
    .action(async (opts: { cacheDir?: string }, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const config = await readConfig(rootDir);
      const cacheDir = opts.cacheDir ?? config?.cache_dir ?? path.join(rootDir, '.bfs', 'cache');

      // Note: variable name `entry` (not `t`) to avoid shadowing the i18n helper.
      const targets: Array<{ label: string; path: string }> = [
        { label: 'push.blob.pending', path: path.join(cacheDir, 'push.blob.pending') },
        { label: 'pull.blob.pending', path: path.join(cacheDir, 'pull.blob.pending') },
        { label: 'push.lock', path: pushLockPath(rootDir) },
        { label: 'repair.lock', path: repairLockPath(rootDir) },
      ];

      try {
        for (const entry of targets) {
          try {
            await fs.unlink(entry.path);
            info(fmt('clear_removed_file', entry.label));
          } catch (e: unknown) {
            if (!isEnoent(e)) throw e;
          }
        }
        success(t('clear_done'));
      } catch (err: unknown) {
        if (err instanceof CommandAbort) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
