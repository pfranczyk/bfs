import type { Command } from 'commander';
import ora from 'ora';
import { t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { listVersions } from '../../vault/vault-manager.js';
import { verifyAll } from '../../vault/verify.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, formatHealth, table } from '../ui.js';

/**
 * Registers the `bfs verify` command on the given Commander program.
 * Checks shard availability for all versions and updates health in manifests.
 * Displays a table with version health, shard counts, and tolerances.
 *
 * @param program - Commander program to attach the command to
 */
export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description(t('cmd_verify_desc'))
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const spinner = ora(t('verify_spinner')).start();
      const io = createCliProviderIO(rootDir);

      try {
        const report = await verifyAll(rootDir, io);
        // Load manifests to get scheme info per version
        const manifests = await listVersions(rootDir);
        const manifestMap = new Map(manifests.map((m) => [m.version, m]));
        spinner.stop();

        if (report.versions.length === 0) {
          console.log(t('verify_no_versions'));
          return;
        }

        const rows = report.versions.map((v) => {
          const manifest = manifestMap.get(v.version);
          const schemeTxt = manifest
            ? `${manifest.scheme.data_shards}/${manifest.scheme.parity_shards}`
            : '?';
          const dataN = manifest?.scheme.data_shards ?? v.available_shards;
          const tolerance =
            v.available_shards >= dataN ? v.available_shards - dataN : 0;
          return [
            `v${String(v.version).padStart(3, '0')}`,
            formatHealth(v.health),
            `${v.available_shards}/${v.total_shards}`,
            schemeTxt,
            tolerance.toString(),
          ];
        });

        console.log();
        table(
          [
            t('verify_col_version'),
            t('verify_col_status'),
            t('verify_col_available'),
            t('verify_col_scheme'),
            t('verify_col_tolerance'),
          ],
          rows,
        );
        console.log();
      } catch (err) {
        spinner.fail(t('verify_failed'));
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
