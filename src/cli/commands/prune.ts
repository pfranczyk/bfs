import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { listVersions, prune } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { inquirer, promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, success, warn } from '../ui.js';

/**
 * Parses a prune range string into a list of version numbers.
 * Supports: single number ("5"), range ("1-10"), comma-separated ("1,3,5").
 *
 * @param rangeStr   - Range string from CLI argument
 * @param allVersions - All available version numbers (used for range validation)
 * @returns           Sorted list of unique version numbers to prune
 * @throws Error if the format is invalid
 */
function parseVersionRange(rangeStr: string, allVersions: number[]): number[] {
  const versions = new Set<number>();

  for (const part of rangeStr.split(',')) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1], 10);
      const to = parseInt(rangeMatch[2], 10);
      if (from > to) throw new Error(`Invalid range: ${trimmed}`);
      for (let v = from; v <= to; v++) versions.add(v);
    } else if (/^\d+$/.test(trimmed)) {
      versions.add(parseInt(trimmed, 10));
    } else {
      throw new Error(`Invalid version format: "${trimmed}"`);
    }
  }

  // Filter to only existing versions
  return [...versions]
    .filter((v) => allVersions.includes(v))
    .sort((a, b) => a - b);
}

/**
 * Registers the `bfs prune` command on the given Commander program.
 *
 * Usage:
 *   bfs prune 5               — delete version 5
 *   bfs prune 1-10            — delete versions 1 to 10
 *   bfs prune 1,3,5           — delete versions 1, 3 and 5
 *   bfs prune --keep-last 3   — keep 3 most recent, delete the rest
 *
 * @param program - Commander program to attach the command to
 */
export function registerPrune(program: Command): void {
  program
    .command('prune [range]')
    .description(t('cmd_prune_desc'))
    .option(
      '--keep-last <n>',
      'Keep the N most recent versions, delete the rest',
    )
    .option('--yes', 'Skip confirmation prompt')
    .action(
      async (
        range: string | undefined,
        opts: { keepLast?: string; yes?: boolean },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);

        try {
          const manifests = await listVersions(rootDir);
          const allVersions = manifests
            .map((m) => m.version)
            .sort((a, b) => a - b);

          if (allVersions.length === 0) {
            console.log(t('prune_no_versions'));
            return;
          }

          let toRemove: number[] = [];

          if (opts.keepLast) {
            const keep = parseInt(opts.keepLast, 10);
            if (Number.isNaN(keep) || keep < 1) {
              error(t('prune_keep_last_invalid'));
              throw new CommandAbort();
            }
            toRemove = allVersions.slice(
              0,
              Math.max(0, allVersions.length - keep),
            );
          } else if (range) {
            toRemove = parseVersionRange(range, allVersions);
          } else {
            const choices = [
              ...allVersions.map((v) => ({ name: `v${v}`, value: String(v) })),
              new inquirer.Separator(),
              {
                name: t('prune_range_manual'),
                value: '__manual__',
              },
            ];
            const { picked } = await promptWithRawMode<{ picked: string[] }>([
              {
                type: 'checkbox',
                name: 'picked',
                message: t('prune_select_prompt'),
                choices,
              },
            ]);
            if (picked.includes('__manual__')) {
              const { rangeInput } = await promptWithRawMode<{
                rangeInput: string;
              }>([
                {
                  type: 'input',
                  name: 'rangeInput',
                  message: t('prune_range_prompt'),
                  validate: (v: string) => (v.trim() ? true : t('required')),
                },
              ]);
              toRemove = parseVersionRange(rangeInput.trim(), allVersions);
            } else {
              toRemove = picked
                .map(Number)
                .filter((v) => allVersions.includes(v))
                .sort((a, b) => a - b);
            }
            if (toRemove.length === 0) {
              console.log(t('prune_no_selected'));
              return;
            }
          }

          if (toRemove.length === 0) {
            console.log(t('prune_no_in_range'));
            return;
          }

          warn(fmt('prune_versions_to_delete', toRemove.join(', ')));

          if (!opts.yes) {
            const { confirmed } = await promptWithRawMode<{
              confirmed: boolean;
            }>([
              {
                type: 'confirm',
                name: 'confirmed',
                message: fmt('prune_confirm', String(toRemove.length)),
                default: false,
              },
            ]);
            if (!confirmed) {
              console.log(t('cancelled'));
              return;
            }
          }

          await prune(rootDir, { versions: toRemove });
          success(fmt('prune_deleted', toRemove.join(', ')));
        } catch (err) {
          if (err instanceof CommandAbort) throw err;
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
      },
    );
}
