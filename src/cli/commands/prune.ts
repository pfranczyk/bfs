import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { listVersions, prune } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { parseVersionRange } from '../parse-version-range.js';
import { inquirer, isPromptCancellation, promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, success, warn } from '../ui.js';

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
    .option('--keep-last <n>', t('prune_opt_keep_last'))
    .option('--yes', t('prune_opt_yes'))
    .action(async (range: string | undefined, opts: { keepLast?: string; yes?: boolean }, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      try {
        const manifests = await listVersions(rootDir);
        const allVersions = manifests.map((m) => m.version).sort((a, b) => a - b);

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
          toRemove = allVersions.slice(0, Math.max(0, allVersions.length - keep));
        } else if (range) {
          toRemove = parseVersionRange(range, allVersions);
        } else {
          const choices = [...allVersions.map((v) => ({ name: `v${v}`, value: String(v) })), new inquirer.Separator(), { name: t('prune_range_manual'), value: '__manual__' }];
          // theme.style.keysHelpTip adds "esc cancel" to the help bar.
          // Cast: legacy inquirer types don't expose @inquirer/checkbox theme.
          let picked: string[] = [];
          try {
            const ans = await promptWithRawMode<{ picked: string[] }>([
              {
                type: 'checkbox',
                name: 'picked',
                message: t('prune_select_prompt'),
                choices,
                theme: { style: { keysHelpTip: (keys: [key: string, action: string][]): string => [...keys, ['esc', t('cancel').toLowerCase()]].map(([k, a]) => `${k} ${a}`).join(' • ') } },
              } as never,
            ]);
            picked = ans.picked;
          } catch (err) {
            if (!isPromptCancellation(err)) throw err;
            // Esc / Ctrl+C → treat as empty selection
          }
          if (picked.includes('__manual__')) {
            try {
              const { rangeInput } = await promptWithRawMode<{ rangeInput: string }>([{ type: 'input', name: 'rangeInput', message: t('prune_range_prompt'), validate: (v: string) => (v.trim() ? true : t('required')) }]);
              toRemove = parseVersionRange(rangeInput.trim(), allVersions);
            } catch (err) {
              if (!isPromptCancellation(err)) throw err;
              // Esc / Ctrl+C → treat as empty selection
            }
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
          let confirmed = false;
          try {
            const ans = await promptWithRawMode<{ confirmed: boolean }>([{ type: 'confirm', name: 'confirmed', message: fmt('prune_confirm', String(toRemove.length)), default: false }]);
            confirmed = ans.confirmed;
          } catch (err) {
            if (!isPromptCancellation(err)) throw err;
            // Esc / Ctrl+C → treat as decline
          }
          if (!confirmed) {
            console.log(t('cancelled'));
            return;
          }
        }

        await prune(rootDir, { versions: toRemove });
        success(fmt('prune_deleted', toRemove.join(', ')));
      } catch (err) {
        if (err instanceof CommandAbort) throw err;
        if (isPromptCancellation(err)) throw err;
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
