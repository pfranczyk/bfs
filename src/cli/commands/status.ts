import chalk from 'chalk';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { status } from '../../vault/vault-manager.js';
import { resolveCwd } from '../cwd.js';
import { CommandAbort, error, warn } from '../ui.js';

/**
 * Registers the `bfs status` command on the given Commander program.
 * Shows vault info: name, versions, scheme, encryption, provider count.
 *
 * @param program - Commander program to attach the command to
 */
export function registerStatus(program: Command): void {
  program
    .command('status')
    .description(t('cmd_status_desc'))
    .action(async (_opts: Record<string, unknown>, cmd: Command) => {
      const rootDir = resolveCwd(cmd);

      try {
        const info = await status(rootDir);

        console.log(chalk.bold(t('status_header')));
        console.log(
          `  ${t('status_name').padEnd(13)} ${chalk.cyan(info.vault_name)}`,
        );
        console.log(
          `  ${t('status_latest').padEnd(13)} v${info.latest_version}`,
        );
        console.log(
          `  ${t('status_on_disk').padEnd(13)} v${info.working_version}`,
        );
        console.log(
          `  ${t('status_scheme').padEnd(13)} ${info.scheme.data_shards}/${info.scheme.parity_shards} ` +
            chalk.dim(
              `(${info.scheme.data_shards} data + ${info.scheme.parity_shards} parity)`,
            ),
        );
        if (info.scheme.data_shards < 2 || info.scheme.parity_shards < 1) {
          warn(
            fmt(
              'status_push_disabled_warn',
              String(info.scheme.data_shards),
              String(info.scheme.parity_shards),
            ),
          );
        }
        console.log(
          `  ${t('status_encryption').padEnd(13)} ${info.encryption_enabled ? chalk.green(t('status_enc_enabled')) : chalk.dim(t('status_enc_disabled'))}`,
        );
        console.log(
          `  ${t('status_providers').padEnd(13)} ${info.provider_count}`,
        );
        console.log();
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        throw new CommandAbort();
      }
    });
}
