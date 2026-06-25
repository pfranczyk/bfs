import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry } from '../../providers/provider.js';
import type { CliProviderInput, ProviderConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { promptWithRawMode } from '../prompt.js';
import { CommandAbort, error, info, success } from '../ui.js';

interface ProviderEditOpts {
  ci?: boolean;
}

/** Recursive sorted-key JSON so two structurally-equal configs stringify
 * identically regardless of key insertion order. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) out[key] = sort(src[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/** True when any non-secret field differs between the old and new config.
 * Non-secret coordinates (host, port, path) live in the shard location map, so
 * a change to one means the stored headers need a resync on the next push;
 * secret fields are never written to shards, so changing only those is local. */
function nonSecretFieldChanged(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>, secretFields: readonly string[]): boolean {
  const keys = new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)]);
  for (const key of keys) {
    if (secretFields.includes(key)) continue;
    if (canonicalJson(oldConfig[key]) !== canonicalJson(newConfig[key])) return true;
  }
  return false;
}

/** Strips the leading positional `[id]` token (if present) from cmd.args so the
 * remainder is the adapter's own flag grammar, mirroring `provider remove`. */
function extractAdapterArgs(cmd: Command): string[] {
  const args = [...cmd.args];
  if (args.length > 0 && !args[0].startsWith('-')) args.shift();
  return args;
}

/**
 * Registers the `bfs provider edit [id]` command.
 *
 * Offline, local-only edit of an existing provider's connection-config in
 * `.bfs/config.json`. The provider type and id are kept; only the connection
 * settings are replaced (full replacement, not a per-field merge). No medium is
 * contacted — there is no healthCheck / probeConnection — so it works when the
 * storage is unreachable (an unplugged USB drive, a path that differs between
 * machines). Structural validation via the adapter's `validateConfig` still
 * runs. The scheme and version manifests are left untouched; a credential
 * change is fully local (secrets never reach shards), while a non-secret
 * coordinate change is synced into shard headers by the next `bfs push`.
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderEdit(providerCmd: Command): void {
  providerCmd
    .command('edit [id]')
    .description(t('cmd_provider_edit_desc'))
    // allowUnknownOption / allowExcessArguments: adapter-specific flags
    // (e.g. --path, --config-file) pass through as cmd.args → rawArgs.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--ci', t('provider_edit_opt_ci'))
    .action(async (providerId: string | undefined, opts: ProviderEditOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const io = createCliProviderIO(rootDir);
      const isCi = opts.ci === true;

      const config = await readConfig(rootDir);
      if (!config) {
        error(t('no_config'));
        throw new CommandAbort();
      }

      if (!providerId) {
        if (isCi) {
          error(t('provider_edit_id_required'));
          throw new CommandAbort();
        }
        if (config.providers.length === 0) {
          error(t('provider_remove_no_providers'));
          throw new CommandAbort();
        }
        const { chosen } = await promptWithRawMode<{ chosen: string }>([
          { type: 'rawlist', name: 'chosen', message: t('provider_edit_prompt'), choices: [...config.providers.map((p, i) => ({ name: `[${i}] ${p.id}  (${p.type || '?'})`, value: p.id })), { name: t('cancel'), value: '__cancel__' }] },
        ]);
        if (chosen === '__cancel__') {
          console.log(t('cancelled'));
          return;
        }
        providerId = chosen;
      }

      const idx = config.providers.findIndex((p) => p.id === providerId);
      if (idx < 0) {
        error(fmt('provider_edit_not_found', providerId));
        throw new CommandAbort();
      }
      const existing = config.providers[idx];

      const factory = providerRegistry.getFactory(existing.type);
      if (!factory) {
        error(fmt('provider_type_unknown', existing.type));
        throw new CommandAbort();
      }
      const instance = factory.create({ id: existing.id, type: existing.type, adapterPackage: existing.adapterPackage, config: {} }, io);

      // Interactive only: show the current config so the operator knows what they
      // are changing. describeConfig masks secret fields — no plaintext leak.
      if (!isCi) {
        info(fmt('provider_edit_current', existing.id));
        info(instance.describeConfig(existing.config));
      }

      let newConfig: Record<string, unknown>;
      if (isCi) {
        try {
          const input: CliProviderInput = { name: existing.id, rawArgs: extractAdapterArgs(cmd) };
          newConfig = await instance.configureFromFlags(input);
        } catch (err) {
          error(fmt('provider_edit_configure_failed', err instanceof Error ? err.message : String(err)));
          throw new CommandAbort();
        }
      } else {
        newConfig = await instance.configureInteractive(io);
      }

      const errors = instance.validateConfig(newConfig);
      if (errors.length > 0) {
        error(fmt('provider_edit_invalid_config', errors.join('; ')));
        throw new CommandAbort();
      }

      if (canonicalJson(existing.config) === canonicalJson(newConfig)) {
        info(fmt('provider_edit_no_changes', existing.id));
        return;
      }

      const coordinatesChanged = nonSecretFieldChanged(existing.config, newConfig, instance.getSecretFields());

      const updated: ProviderConfig = { ...existing, config: newConfig };
      config.providers[idx] = updated;
      await writeConfig(rootDir, config);

      success(fmt('provider_edit_success', existing.id));
      if (coordinatesChanged) info(t('provider_edit_synced_hint'));
    });
}
