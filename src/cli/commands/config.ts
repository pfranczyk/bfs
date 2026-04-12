import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { error, info, success } from '../ui.js';

const FEATURE_MAP: Record<string, 'compression' | 'encryption'> = {
  compress: 'compression',
  compression: 'compression',
  encryption: 'encryption',
  encrypt: 'encryption',
};

/**
 * Registers the `bfs config` command on the given Commander program.
 *
 * Without arguments: displays current settings (cache/temp/ram + compression/encryption).
 * With --cache-dir/--temp-dir/--max-ram: updates those settings.
 * With --on <feature> / --off <feature>: toggles compression or encryption in vault config.
 * With --reset: resets cache/temp/ram setting to default.
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
    .option('--on <feature>', t('config_opt_on'))
    .option('--off <feature>', t('config_opt_off'))
    .action(
      async (
        opts: {
          cacheDir?: string | true;
          tempDir?: string | true;
          maxRam?: string | true;
          reset?: boolean;
          on?: string;
          off?: string;
        },
        cmd: Command,
      ) => {
        const rootDir = resolveCwd(cmd);
        const config = await readConfig(rootDir);
        if (!config) {
          error(t('no_config'));
          return;
        }

        // ── --on / --off <feature> ────────────────────────────────────────────
        if (opts.on !== undefined || opts.off !== undefined) {
          const featureArg = opts.on ?? opts.off ?? '';
          const featureKey = FEATURE_MAP[featureArg.toLowerCase()];
          if (!featureKey) {
            error(fmt('config_feature_unknown', featureArg));
            return;
          }
          const enable = opts.on !== undefined;
          if (featureKey === 'compression') {
            if (!config.compression)
              config.compression = { enabled: enable, algorithm: 'deflate' };
            else config.compression.enabled = enable;
          } else {
            if (!config.encryption)
              config.encryption = {
                enabled: enable,
                algorithm: 'aes-256-gcm',
                kdf: 'argon2id',
              };
            else config.encryption.enabled = enable;
          }
          await writeConfig(rootDir, config);
          const displayName =
            featureKey === 'compression'
              ? t('config_label_compression')
              : t('config_label_encryption');
          success(
            fmt(
              enable ? 'config_feature_on' : 'config_feature_off',
              displayName,
            ),
          );
          info(t('config_next_push'));
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
          const compressState = config.compression?.enabled
            ? t('status_enc_enabled')
            : t('status_enc_disabled');
          const encState = config.encryption?.enabled
            ? t('status_enc_enabled')
            : t('status_enc_disabled');
          info(
            `  ${t('config_label_compression').padEnd(14)} ${compressState}`,
          );
          info(`  ${t('config_label_encryption').padEnd(14)} ${encState}`);
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
