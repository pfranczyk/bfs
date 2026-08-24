import type { Command } from 'commander';
import ora from 'ora';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { VersionHealth } from '../../types/index.js';
import { listVersions } from '../../vault/vault-manager.js';
import { verifyAll } from '../../vault/verify.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { createSpinnerIo } from '../spinner-io.js';
import { CommandAbort, error, formatHealth, table, warn } from '../ui.js';

/** Exit code for a backup that is still restorable but has lost redundancy. */
const EXIT_DEGRADED = 4;
/** Exit code for a backup that can no longer be restored. */
const EXIT_DAMAGED = 5;

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
    .option('--deep', t('verify_opt_deep'))
    .action(async (opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const spinner = ora(t('verify_spinner')).start();
      const io = createCliProviderIO(rootDir, isCiRun(cmd) ? false : undefined);
      // Every reason a part is lost is reported while the spinner animates, so
      // the reasons must pause it - an unreachable medium is a routine finding
      // here, not a rarity, and its line would otherwise be drawn over.
      const wrappedIo = createSpinnerIo(io, spinner);

      try {
        const report = await verifyAll(rootDir, wrappedIo, { deep: Boolean(opts.deep) });
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
          const schemeTxt = manifest ? `${manifest.scheme.data_shards}/${manifest.scheme.parity_shards}` : '?';
          const dataN = manifest?.scheme.data_shards ?? v.available_shards;
          // A carried-over verdict means the data is known bad while the parts are
          // all present, so a tolerance derived from that count would read as
          // spare redundancy the backup does not have.
          const tolerance = v.retained_from_deep || v.available_shards < dataN ? 0 : v.available_shards - dataN;
          return [`v${String(v.version).padStart(3, '0')}`, formatHealth(v.health), `${v.available_shards}/${v.total_shards}`, schemeTxt, tolerance.toString()];
        });

        console.log();
        table([t('verify_col_version'), t('verify_col_status'), t('verify_col_available'), t('verify_col_scheme'), t('verify_col_tolerance')], rows);
        console.log();

        for (const v of report.versions) {
          if (v.header_advisory === null) continue;
          const count = v.header_advisory.missing + v.header_advisory.broken;
          warn(fmt('verify_header_advisory', `v${String(v.version).padStart(3, '0')}`, String(count)));
        }

        // A retained verdict looks contradictory in the table - "damaged" beside
        // a full shard count - because this run never read the data. Say where it
        // came from, so the operator knows what to run to refresh it.
        for (const v of report.versions) {
          if (v.retained_from_deep) warn(fmt('verify_verdict_retained', `v${String(v.version).padStart(3, '0')}`));
        }

        // The exit code carries the worst verdict, so a scheduled check can alarm
        // without parsing the table. Distinct from the generic failure code (1),
        // which means verify itself could not run - a monitor must be able to tell
        // "the backup is damaged" from "the check never happened". Header advisory
        // stays out of it: it is orthogonal to whether the data is recoverable.
        if (report.versions.some((v) => v.health === VersionHealth.Damaged)) throw new CommandAbort(EXIT_DAMAGED);
        if (report.versions.some((v) => v.health === VersionHealth.Degraded)) throw new CommandAbort(EXIT_DEGRADED);
      } catch (err) {
        if (err instanceof CommandAbort) throw err;
        spinner.fail(t('verify_failed'));
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
