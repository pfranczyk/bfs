import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { t } from '../../i18n/index.js';
import { resolveCwd } from '../cwd.js';
import { success } from '../ui.js';

/**
 * Registers the `bfs clear` command on the given Commander program.
 * Deletes cached blobs left over from aborted push/pull operations:
 *   .bfs/cache/push.blob.pending
 *   .bfs/cache/pull.blob.pending
 *
 * @param program - Commander program to attach the command to
 */
export function registerClear(program: Command): void {
  program
    .command('clear')
    .description(t('cmd_clear_desc'))
    .action(async (_opts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const pushCache = path.join(
        rootDir,
        '.bfs',
        'cache',
        'push.blob.pending',
      );
      const pullCache = path.join(
        rootDir,
        '.bfs',
        'cache',
        'pull.blob.pending',
      );
      await fs.unlink(pushCache).catch(() => {});
      await fs.unlink(pullCache).catch(() => {});
      success(t('clear_done'));
    });
}
