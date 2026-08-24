import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { readConfig } from '../../vault/config.js';
import { listManifests } from '../../vault/manifest.js';
import { repairVault } from '../../vault/repair.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { parseRepairSpec } from '../parse-provider-spec.js';
import { parseVersionRange } from '../parse-version-range.js';
import { readPasswordFiles } from '../password-input.js';
import { isPromptCancellation } from '../prompt.js';
import { CommandAbort, error, success, warn } from '../ui.js';

interface RepairOpts {
  version?: string;
  password: string[];
  passwordFile: string[];
  ci?: boolean;
  rebuild?: boolean;
  forceUnverified?: boolean;
  restoreHeaders?: boolean;
}

/**
 * Registers the `bfs repair` command.
 *
 * Repairs a provider whose coordinates drifted (cross-OS path change, rotated
 * credential). Rewrites `.bfs/config.json` (global) and the sibling shards'
 * location maps for the selected versions, so a fresh recovery finds the
 * provider at its new address. With `--rebuild` it also reconstructs a lost
 * shard from RS parity; with `--restore-headers` it rebuilds the missing header
 * sidecars instead and takes no pair at all.
 *
 * Usage: `bfs repair [--version <range>] [--password <p>]... [--password-file <path>]...
 *                    [--ci] [--rebuild] [--force-unverified] <name> "<params>" ...`
 *    or: `bfs repair [--version <range>] --restore-headers`
 * Each `<params>` is one quoted string of the adapter's own flags (full
 * replacement of the connection config, mirroring `bfs provider edit`).
 *
 * @param program - Commander program to attach the command to
 */
export function registerRepair(program: Command): void {
  program
    .command('repair')
    .description(t('cmd_repair_desc'))
    // Adapter flags inside each "<params>" string arrive as unknown options; keep
    // them as positional operands in cmd.args instead of erroring.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    // The device name and settings string are read straight out of cmd.args, so
    // Commander generates a usage line that mentions neither. Spell the syntax
    // out here rather than declaring arguments: a declared operand would change
    // the action signature and break `--restore-headers`, which takes none.
    .addHelpText('after', `\n${t('repair_help_syntax')}`)
    .option('--version <range>', t('repair_opt_version'))
    .option('--password <password>', t('repair_opt_password'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--password-file <path>', t('repair_opt_password_file'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--ci', t('repair_opt_ci'))
    .option('--rebuild', t('repair_opt_rebuild'))
    .option('--force-unverified', t('repair_opt_force_unverified'))
    .option('--restore-headers', t('repair_opt_restore_headers'))
    .action(async (opts: RepairOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      // --ci disables prompts: a missing provider path is then auto-created
      // instead of asking, so relocating to a machine where the source paths
      // don't exist (cross-OS restore) doesn't abort on an unanswerable prompt.
      // Anything else defers to the TTY check inside createCliProviderIO - the
      // other half of the contract at `ProviderIO.interactive`. This command has
      // no prompts of its own, so a run from cron without --ci would otherwise
      // reach an adapter claiming a terminal that is not there.
      const isCi = isCiRun(cmd, opts.ci);
      const io = createCliProviderIO(rootDir, isCi ? false : undefined);

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      try {
        const restoreHeaders = opts.restoreHeaders === true;
        if (restoreHeaders && opts.rebuild === true) {
          error(t('repair_restore_headers_rebuild_conflict'));
          throw new CommandAbort();
        }
        if (restoreHeaders && cmd.args.length > 0) {
          error(t('repair_restore_headers_no_pairs'));
          throw new CommandAbort();
        }
        const pairs = restoreHeaders
          ? []
          : await parseRepairSpec(
              cmd.args,
              config.providers.map((p) => p.id),
              io,
            );
        const allVersions = (await listManifests(rootDir)).map((m) => m.version);
        const versions = parseVersionRange(opts.version ?? (restoreHeaders ? 'all' : 'latest'), allVersions, { allowKeywords: true });
        const passwords = [...opts.password, ...(await readPasswordFiles(opts.passwordFile))];

        const result = await repairVault(rootDir, { pairs, versions, io, passwords, rebuild: opts.rebuild === true, forceUnverified: opts.forceUnverified === true, restoreHeaders });

        if (result.failed_pairs.length > 0 || result.failed_shards.length > 0) {
          const failed = [...result.failed_pairs.map((f) => f.name), ...result.failed_shards.map((f) => `${f.pair_name} v${f.version}`)];
          warn(fmt('repair_partial', failed.join(', ')));
          throw new CommandAbort();
        }
        if (restoreHeaders) {
          success(fmt('repair_restore_headers_success', String(versions.length)));
        } else {
          success(fmt('repair_success', result.succeeded.map((s) => s.old_name).join(', ')));
        }
      } catch (err) {
        if (err instanceof CommandAbort || isPromptCancellation(err)) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
