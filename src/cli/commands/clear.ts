import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { t } from '../../i18n/index.js';
import { readConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { success } from '../ui.js';

/**
 * Registers the `bfs clear` command on the given Commander program.
 * Deletes cached blobs left over from aborted push/pull operations:
 *   <cacheDir>/push.blob.pending
 *   <cacheDir>/pull.blob.pending
 *
 * Cache directory resolution order: --cache-dir flag → config.cache_dir → {rootDir}/.bfs/cache.
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
      const cacheDir =
        opts.cacheDir ??
        config?.cache_dir ??
        path.join(rootDir, '.bfs', 'cache');
      const pushCache = path.join(cacheDir, 'push.blob.pending');
      const pullCache = path.join(cacheDir, 'pull.blob.pending');
      await fs.unlink(pushCache).catch(() => {});
      await fs.unlink(pullCache).catch(() => {});
      success(t('clear_done'));
    });
}
