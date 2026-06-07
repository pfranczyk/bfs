import type { Command } from 'commander';
import { t } from '../../i18n/index.js';
import { listVersions } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, formatBytes, formatHealth, table } from '../ui.js';

/**
 * Registers the `bfs versions` command on the given Commander program.
 * Displays a table of all versions with health status, shard count, and size info.
 *
 * @param program - Commander program to attach the command to
 */
export function registerVersions(program: Command): void {
  program
    .command('versions')
    .description(t('cmd_versions_desc'))
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      try {
        const manifests = await listVersions(rootDir);

        if (manifests.length === 0) {
          console.log(t('versions_empty'));
          return;
        }

        const rows = manifests.map((m) => [
          `v${String(m.version).padStart(3, '0')}`,
          formatHealth(m.health),
          `${m.scheme.data_shards}/${m.scheme.parity_shards}`,
          m.shards.length.toString(),
          m.file_count !== null ? m.file_count.toString() : '?',
          m.total_size !== null ? formatBytes(m.total_size) : '?',
          m.pushed_at ? new Date(m.pushed_at).toLocaleString() : '—',
        ]);

        console.log();
        table([t('versions_col_version'), t('versions_col_status'), t('versions_col_scheme'), t('versions_col_shards'), t('versions_col_files'), t('versions_col_size'), t('versions_col_pushed_at')], rows);
        console.log();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
