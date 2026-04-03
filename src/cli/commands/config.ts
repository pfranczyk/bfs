import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { error, info, success } from '../ui.js';

/**
 * Registers the `bfs config` command on the given Commander program.
 *
 * Without arguments: displays current cache_dir and temp_dir settings.
 * With --cache-dir <path>: sets cache_dir in config.json.
 * With --temp-dir <path>: sets temp_dir in config.json.
 * With --cache-dir --reset (no path): resets cache_dir to default (null).
 * With --temp-dir --reset (no path): resets temp_dir to default (null).
 *
 * Note: --cache-dir and --temp-dir accept optional values ([path]).
 * When combined with --reset and no path given, the value is `true` (boolean)
 * which signals "reset this setting".
 *
 * @param program - Commander program to attach the command to
 */
export function registerConfig(program: Command): void {
  program
    .command('config')
    .description(t('cmd_config_desc'))
    .option('--cache-dir [path]', t('config_opt_cache_dir'))
    .option('--temp-dir [path]', t('config_opt_temp_dir'))
    .option('--max-ram [mb]', t('config_opt_max_ram'))
    .option('--reset', t('config_opt_reset'))
    .action(
      async (
        opts: {
          cacheDir?: string | true;
          tempDir?: string | true;
          maxRam?: string | true;
          reset?: boolean;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const config = await readConfig(rootDir);
        if (!config) {
          error(t('no_config'));
          return;
        }

        if (
          opts.reset === true &&
          opts.cacheDir === undefined &&
          opts.tempDir === undefined &&
          opts.maxRam === undefined
        ) {
          error(t('config_reset_no_field'));
          return;
        }

        const hasChange =
          opts.cacheDir !== undefined ||
          opts.tempDir !== undefined ||
          opts.maxRam !== undefined;

        if (!hasChange) {
          // Display current settings
          const cacheDefault = path.join(rootDir, '.bfs', 'cache');
          info(t('config_current_settings'));
          info(
            `  cache-dir: ${config.cache_dir ?? `(default: ${cacheDefault})`}`,
          );
          info(`  temp-dir:  ${config.temp_dir ?? '(default: system temp)'}`);
          info(
            `  max-ram:   ${config.max_ram_mb != null ? `${config.max_ram_mb} MB` : '(auto: 25% system RAM)'}`,
          );
          return;
        }

        let changed = false;
        const isReset = (v: string | true | undefined): boolean =>
          opts.reset === true || v === true;

        if (opts.cacheDir !== undefined) {
          if (!isReset(opts.cacheDir)) {
            const p = path.resolve(opts.cacheDir as string);
            const parent = path.dirname(p);
            const stat = await fs.stat(parent).catch(() => null);
            if (!stat?.isDirectory()) {
              error(fmt('dir_not_exist', p));
              return;
            }
          }
          config.cache_dir = isReset(opts.cacheDir)
            ? null
            : (opts.cacheDir as string);
          changed = true;
        }

        if (opts.tempDir !== undefined) {
          if (!isReset(opts.tempDir)) {
            const p = path.resolve(opts.tempDir as string);
            const parent = path.dirname(p);
            const stat = await fs.stat(parent).catch(() => null);
            if (!stat?.isDirectory()) {
              error(fmt('dir_not_exist', p));
              return;
            }
          }
          config.temp_dir = isReset(opts.tempDir)
            ? null
            : (opts.tempDir as string);
          changed = true;
        }

        if (opts.maxRam !== undefined) {
          config.max_ram_mb = isReset(opts.maxRam)
            ? null
            : parseInt(opts.maxRam as string, 10);
          changed = true;
        }

        if (changed) {
          await writeConfig(rootDir, config);
          success(
            opts.reset === true ||
              opts.cacheDir === true ||
              opts.tempDir === true ||
              opts.maxRam === true
              ? t('config_reset')
              : t('config_updated'),
          );
        }
      },
    );
}
