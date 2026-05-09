import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import {
  createCliProviderIO,
  providerRegistry,
} from '../../providers/provider.js';
import { readConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, table } from '../ui.js';

/**
 * Registers the `bfs provider list` command.
 * Displays all configured providers with their type and connection info.
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderList(providerCmd: Command): void {
  providerCmd
    .command('list')
    .description(t('cmd_provider_list_desc'))
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      if (config.providers.length === 0) {
        console.log(t('provider_list_empty'));
        return;
      }

      console.log(
        fmt(
          'provider_list_header',
          chalk.cyan(config.vault_name),
          String(config.scheme.data_shards),
          String(config.scheme.parity_shards),
        ),
      );

      const io = createCliProviderIO(rootDir);
      const rows = config.providers.map((p, i) => {
        const factory = providerRegistry.getFactory(p.type);
        let connInfo: string;
        if (factory) {
          connInfo = factory.create(p, io).describeConfig(p.config);
        } else {
          // Unknown type (e.g. plugin not loaded) — fall back to a minimal,
          // non-secret-aware dump so the row still renders.
          connInfo = `(unknown type "${p.type}")`;
        }
        return [String(i), p.id, p.type, connInfo || '—'];
      });

      table(
        [
          t('provider_list_col_num'),
          t('provider_list_col_id'),
          t('provider_list_col_type'),
          t('provider_list_col_config'),
        ],
        rows,
      );
      console.log();
    });
}
