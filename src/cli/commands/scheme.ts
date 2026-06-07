import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, info, success } from '../ui.js';

/**
 * Registers the `bfs scheme set <data> <parity>` command.
 * Changes the vault scheme (N/K). The new N+K must match the current
 * number of configured providers.
 *
 * @param program - The root Commander program
 */
export function registerScheme(program: Command): void {
  const schemeCmd = program.command('scheme').description(t('cmd_scheme_desc'));

  schemeCmd
    .command('set <data> <parity>')
    .description(t('cmd_scheme_set_desc'))
    .action(async (dataArg: string, parityArg: string, _opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      const N = Number.parseInt(dataArg, 10);
      const K = Number.parseInt(parityArg, 10);

      if (!Number.isInteger(N) || N < 2) {
        error(t('scheme_data_shards_invalid'));
        throw new CommandAbort();
      }
      if (!Number.isInteger(K) || K < 1) {
        error(t('scheme_parity_shards_invalid'));
        throw new CommandAbort();
      }

      const required = N + K;
      const current = config.providers.length;

      if (required !== current) {
        error(fmt('scheme_requires', String(N), String(K), String(required), String(current)));
        if (required > current) {
          info(fmt('scheme_add_providers', String(required - current)));
        } else {
          info(fmt('scheme_remove_providers', String(current - required)));
        }
        throw new CommandAbort();
      }

      const old = `${config.scheme.data_shards}/${config.scheme.parity_shards}`;
      await writeConfig(rootDir, { ...config, scheme: { data_shards: N, parity_shards: K } });

      success(fmt('scheme_changed', old, String(N), String(K)));
      info(t('scheme_apply_push'));
    });
}
