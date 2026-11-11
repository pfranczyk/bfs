import { isIdentityDeclined } from '../core/errors.js';
import { fmt, t } from '../i18n/index.js';
import type { ProviderFactory } from '../providers/provider.js';
import type { ProviderIO, StorageProvider } from '../types/index.js';
import { isPromptCancellation } from './prompt.js';
import { CommandAbort, error, info, warn } from './ui.js';

/** Provider identity needed to (re)build the adapter across the recovery loop. */
interface ProbeRef {
  id: string;
  type: string;
  adapterPackage: Nullable<string>;
}

/** Inputs for {@link probeProviderWithRecovery}. */
interface ProbeProviderOptions {
  /** Adapter factory for the chosen provider type. */
  factory: ProviderFactory;
  /** Provider identity (id, type, adapterPackage). */
  ref: ProbeRef;
  /** Provider IO for prompts and connection chatter. */
  io: ProviderIO;
  /** Vault name the probe resolves its target path against. */
  vaultName: string;
}

type RecoveryChoice = 'retry' | 'reenter' | 'abort';

/**
 * Offers the operator a recovery choice after a rejected config / failed probe.
 * Selection is matched by value, then mapped to a stable discriminant so the
 * caller branches on intent rather than on translated wording.
 *
 * @param io - Provider IO used to present the choice
 * @returns the chosen recovery action
 */
async function askRecoveryChoice(io: ProviderIO): Promise<RecoveryChoice> {
  const retry = t('probe_choice_retry');
  const reenter = t('probe_choice_reenter');
  const choice = await io.choose(t('probe_failed_prompt'), [retry, reenter, t('probe_choice_abort')]);
  if (choice === retry) return 'retry';
  if (choice === reenter) return 'reenter';
  return 'abort';
}

/**
 * Collects a provider's connection config interactively, validates it, then
 * probes connectivity before accepting it. A rejected config or a failed probe -
 * transient, or a typo in host/port/password/path - is recoverable in place
 * (retry / re-enter / abort), so a single failure never discards the whole
 * interactive session. Shared by `bfs init` and `bfs provider add`.
 *
 * Acceptance is gated on validateConfig() AND a full storage round-trip
 * (probeConnection()), not a bare connect/login: authenticate() can succeed
 * against a server whose base path is unusable (an FTP LIST of a nonexistent
 * path returns empty), silently accepting a provider that only fails later at
 * push. probeConnection() needs the vault name to resolve its target path.
 *
 * The adapter's own questions sit inside the same loop: configuring an FTPS or
 * SSH storage reads the server identity, so an unreachable server (or the
 * adapter's limit on going back) fails there, and ending the command at that
 * point would cost every value entered so far. With no configuration collected
 * yet there is nothing to re-probe, so "retry" asks the questions again, as
 * "re-enter" does. A prompt cancellation (Ctrl+C) is never caught, and neither
 * is the operator refusing the server identity in the adapter's questions
 * (IdentityDeclinedError) - both are the operator ending the command, not a
 * failure to recover from.
 *
 * @param options - Factory, provider identity, IO, and vault name (see {@link ProbeProviderOptions})
 * @returns the connection config that validated and probed successfully
 * @throws CommandAbort when the operator chooses to abort or refuses the server identity
 */
export async function probeProviderWithRecovery({ factory, ref, io, vaultName }: ProbeProviderOptions): Promise<Record<string, unknown>> {
  const make = (config: Record<string, unknown>) => factory.create({ id: ref.id, type: ref.type, adapterPackage: ref.adapterPackage, config }, io);
  let config: Nullable<Record<string, unknown>> = null;
  for (;;) {
    let failure: Nullable<string> = null;
    try {
      if (config === null) config = await _configure(make({}), io, ref.id);
      const instance = make(config);
      const errors = instance.validateConfig(config);
      if (errors.length > 0) {
        failure = fmt('probe_validate_failed', ref.id, errors.join('; '));
      } else {
        info(fmt('probe_connection', ref.id));
        instance.setVaultName(vaultName);
        await instance.probeConnection();
        return config;
      }
    } catch (err) {
      if (isPromptCancellation(err) || err instanceof CommandAbort) throw err;
      failure = err instanceof ConfigureFailure ? err.message : fmt('probe_failed', ref.id, err instanceof Error ? err.message : String(err));
    }
    warn(failure);
    const choice = await askRecoveryChoice(io);
    if (choice === 'retry') continue;
    if (choice === 'reenter') {
      config = null;
      continue;
    }
    throw new CommandAbort();
  }
}

/** A failure of the adapter's own questions, already worded for the operator. */
class ConfigureFailure extends Error {}

/**
 * Runs the adapter's configuration questions. A refused server identity ends the
 * command with its own message; any other failure is reworded as a failed
 * set-up (not a failed connection test) for the recovery menu.
 */
async function _configure(instance: StorageProvider, io: ProviderIO, id: string): Promise<Record<string, unknown>> {
  try {
    return await instance.configureInteractive(io);
  } catch (err) {
    if (isPromptCancellation(err)) throw err;
    if (isIdentityDeclined(err)) {
      error(err instanceof Error ? err.message : String(err));
      throw new CommandAbort();
    }
    throw new ConfigureFailure(fmt('probe_configure_failed', id, err instanceof Error ? err.message : String(err)));
  }
}
