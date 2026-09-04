import type { Command } from 'commander';
import { fmt, t } from '../../i18n/index.js';
import { createCliProviderIO, providerRegistry } from '../../providers/provider.js';
import type { CliProviderInput, ProviderConfig } from '../../types/index.js';
import { readConfig, writeConfig } from '../../vault/config.js';
import { resolveCwd } from '../cwd.js';
import { isCiRun } from '../interactive-mode.js';
import { isPromptCancellation, promptWithRawMode } from '../prompt.js';
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
 * Edits an existing provider's connection-config in `.bfs/config.json`. The
 * provider type and id are kept; only the connection settings are replaced (full
 * replacement, not a per-field merge). This command itself runs no healthCheck /
 * probeConnection and writes nothing to the medium, so nothing here depends on
 * the storage being reachable - every `--ci` path completes with the medium
 * gone. Interactively it is the adapter's configure flow that decides, and all
 * three built-ins implement `configureInteractiveForEdit` for it: SSH and FTPS
 * reuse the pinned host key / certificate when host and port did not move, and
 * degrade to an offline menu when a genuinely new target is unreachable; LocalFs
 * offers a directory that does not exist yet for confirmation instead of
 * re-asking. Structural validation via the adapter's `validateConfig` still runs.
 * The scheme and version manifests are left untouched; a credential change is
 * fully local (secrets never reach shards), while a non-secret coordinate change
 * is synced into shard headers by the next `bfs push`.
 *
 * @param providerCmd - The `bfs provider` sub-command to attach to
 */
export function registerProviderEdit(providerCmd: Command): void {
  providerCmd
    .command('edit [id]')
    .description(t('cmd_provider_edit_desc'))
    // allowUnknownOption / allowExcessArguments: adapter-specific flags
    // (e.g. --path, --config-file) pass through as cmd.args -> rawArgs.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .option('--ci', t('provider_edit_opt_ci'))
    .action(async (providerId: string | undefined, opts: ProviderEditOpts, cmd: Command) => {
      const rootDir = resolveCwd(cmd);
      const isCi = isCiRun(cmd, opts.ci);
      // `--ci` states non-interactive outright; anything else leaves the answer
      // to the TTY check inside createCliProviderIO. Both halves are the contract
      // at `ProviderIO.interactive` (src/types/index.ts): false under `--ci` OR
      // with no terminal attached - a data-carrying flag like `--bootstrap` never
      // sets it. A plain `!isCi` covers only the first half and would claim
      // interactivity for an edit whose stdin is a pipe.
      const io = createCliProviderIO(rootDir, isCi ? false : undefined);

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
      // are changing. describeConfig masks secret fields - no plaintext leak.
      if (!isCi) {
        info(fmt('provider_edit_current', existing.id));
        info(instance.describeConfig(existing.config));
      }

      let newConfig: Record<string, unknown>;
      if (isCi) {
        try {
          // Offline by contract - no medium contact. An adapter flag that needs a
          // live connection (SSH --accept-new-host-key) must refuse here.
          const input: CliProviderInput = { name: existing.id, rawArgs: extractAdapterArgs(cmd), offline: true };
          newConfig = await instance.configureFromFlags(input);
        } catch (err) {
          error(fmt('provider_edit_configure_failed', err instanceof Error ? err.message : String(err)));
          throw new CommandAbort();
        }
      } else {
        // Edit routes through the provider's edit-aware flow when present; the
        // fallback is for external adapters that predate the hook - every
        // built-in has it. However the adapter stops - a refused host key, a
        // declined certificate, its own reason - the stop is reported here and
        // the stored config is left alone. Not keyed on the error's class: the
        // classes that can arrive say a provider operation failed, not that the
        // operator changed their mind, and only the adapter's own message can
        // tell those apart. A class test would also have to hold across the
        // bundle boundary, where an adapter's error is a different object than
        // the one this file imported.
        //
        // A cancelled prompt is the exception and travels on untouched: the
        // runtime answers it with its own exit code, and reporting it here would
        // turn an interrupted session into a refused edit. Recognised through
        // isPromptCancellation, which matches by name as well, so a cancellation
        // raised by the runtime's own copy of the prompt library still counts.
        try {
          newConfig = instance.configureInteractiveForEdit ? await instance.configureInteractiveForEdit(io, { existingConfig: existing.config }) : await instance.configureInteractive(io);
        } catch (err) {
          if (isPromptCancellation(err)) throw err;
          error(err instanceof Error ? err.message : String(err));
          throw new CommandAbort();
        }
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
