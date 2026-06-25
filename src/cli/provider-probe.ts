import { fmt, t } from '../i18n/index.js';
import type { ProviderFactory } from '../providers/provider.js';
import type { ProviderIO } from '../types/index.js';
import { isPromptCancellation } from './prompt.js';
import { CommandAbort, info, warn } from './ui.js';

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
 * probes connectivity before accepting it. A rejected config or a failed probe
 * — transient, or a typo in host/port/password/path — is recoverable in place
 * (retry / re-enter / abort), so a single failure never discards the whole
 * interactive session. Shared by `bfs init` and `bfs provider add`.
 *
 * Acceptance is gated on validateConfig() AND a full storage round-trip
 * (probeConnection()), not a bare connect/login: authenticate() can succeed
 * against a server whose base path is unusable (an FTP LIST of a nonexistent
 * path returns empty), silently accepting a provider that only fails later at
 * push. probeConnection() needs the vault name to resolve its target path.
 *
 * @param options - Factory, provider identity, IO, and vault name (see {@link ProbeProviderOptions})
 * @returns the connection config that validated and probed successfully
 * @throws CommandAbort when the operator chooses to abort
 */
export async function probeProviderWithRecovery({ factory, ref, io, vaultName }: ProbeProviderOptions): Promise<Record<string, unknown>> {
  const make = (config: Record<string, unknown>) => factory.create({ id: ref.id, type: ref.type, adapterPackage: ref.adapterPackage, config }, io);
  let config = await make({}).configureInteractive(io);
  for (;;) {
    let failure: Nullable<string> = null;
    try {
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
      if (isPromptCancellation(err)) throw err;
      failure = fmt('probe_failed', ref.id, err instanceof Error ? err.message : String(err));
    }
    warn(failure);
    const choice = await askRecoveryChoice(io);
    if (choice === 'retry') continue;
    if (choice === 'reenter') {
      config = await make({}).configureInteractive(io);
      continue;
    }
    throw new CommandAbort();
  }
}
