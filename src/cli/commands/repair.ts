import fs from 'node:fs/promises';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO } from '../../providers/provider.js';
import { readConfig } from '../../vault/config.js';
import { listManifests } from '../../vault/manifest.js';
import { repairVault } from '../../vault/repair.js';
import { resolveCwd } from '../cwd.js';
import { parseRepairSpec } from '../parse-provider-spec.js';
import { parseVersionRange } from '../parse-version-range.js';
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
 * Repairs a provider whose payload is intact but whose coordinates drifted
 * (cross-OS path change, rotated credential). Rewrites `.bfs/config.json`
 * (global) and the sibling shards' location maps for the selected versions, so
 * a fresh recovery finds the provider at its new address.
 *
 * Usage: `bfs repair [--version <range>] [--password <p>]... [--ci] <name> "<params>" ...`
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
    .option('--version <range>', t('repair_opt_version'))
    .option('--password <password>', t('repair_opt_password'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--password-file <path>', t('repair_opt_password_file'), (val: string, prev: string[]) => [...prev, val], [] as string[])
    .option('--ci', t('repair_opt_ci'))
    .option('--rebuild', t('repair_opt_rebuild'))
    .option('--force-unverified', t('repair_opt_force_unverified'))
    .option('--restore-headers', t('repair_opt_restore_headers'))
    .action(async (opts: RepairOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const io = createCliProviderIO(rootDir);

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
              rootDir,
            );
        const allVersions = (await listManifests(rootDir)).map((m) => m.version);
        const versions = parseVersionRange(opts.version ?? (restoreHeaders ? 'all' : 'latest'), allVersions, { allowKeywords: true });
        const passwords = [...opts.password, ...(await readPasswordFiles(opts.passwordFile))];

        const result = await repairVault(rootDir, { pairs, versions, io, passwords, isCi: opts.ci === true, rebuild: opts.rebuild === true, forceUnverified: opts.forceUnverified === true, restoreHeaders });

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

/**
 * Reads each password file as UTF-8, trimming a single trailing newline (LF or
 * CRLF). The CRLF case matters on Windows, where an editor-saved password file
 * ends in `\r\n`; stripping only `\n` would leave a stray `\r` in the password
 * and reject an otherwise-correct credential.
 */
export async function readPasswordFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const content = await fs.readFile(p, 'utf-8');
    out.push(content.replace(/\r?\n$/, ''));
  }
  return out;
}
