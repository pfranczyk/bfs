import { fmt } from '../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../providers/provider.js';
import type { ProviderConfig } from '../types/index.js';
import { shellParse } from './shell-parse.js';

/**
 * Result of parsing a recovery `--bootstrap` spec. Caller (`bfs recovery`)
 * combines this with the separately-supplied `--provider <type>` and a
 * hardcoded id (`recovery-bootstrap`) to construct the bootstrap provider.
 */
export interface RecoveryBootstrapSpec {
  /** Adapter package "name@version" for external adapters; null for built-ins. */
  readonly adapterPackage: Nullable<string>;
  /** Provider config returned by `configureFromFlags`, ready for `factory.create`. */
  readonly config: Record<string, unknown>;
}

/**
 * Parses an init-style provider spec into a fully-formed `ProviderConfig`.
 *
 * Grammar: `type:name [adapter-flags]` tokenized shell-style. The first token
 * holds `type:name`; remaining tokens are forwarded verbatim as `rawArgs` to
 * `StorageProvider.configureFromFlags`. BFS never inspects adapter-flags —
 * each adapter defines its own flag grammar.
 *
 * @param spec - raw value of a single `--provider` flag (e.g. `bfs init --ci`)
 * @param cwd  - BFS working directory, exposed to adapters via `io.workDir`
 * @returns     a `ProviderConfig` ready to drop into `VaultConfig.providers`
 * @throws      Error when the format is invalid, the id charset rule is
 *              violated, or the adapter rejects the resulting configuration
 */
export async function parseInitProviderSpec(spec: string, cwd: string): Promise<ProviderConfig> {
  const tokens = shellParse(spec);
  if (tokens.length === 0) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }
  const head = tokens[0];
  const firstColon = head.indexOf(':');
  if (firstColon <= 0 || firstColon === head.length - 1) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }
  const type = head.slice(0, firstColon);
  const factory = providerRegistry.getFactory(type);
  if (!factory) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }
  const meta = providerRegistry.getMeta(type);
  const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;

  // After the first colon the entire head is the id. The charset regex
  // forbids further `:`, whitespace, or quote chars — multi-segment forms
  // like `local:id:/path` fail validation with init_provider_format_invalid.
  const id = head.slice(firstColon + 1);
  validateProviderId(id);
  const rawArgs = tokens.slice(1);
  const io = createCliProviderIO(cwd);
  const placeholder = factory.create({ id, type, adapterPackage, config: {} }, io);
  const config = await placeholder.configureFromFlags({ name: id, rawArgs });
  const errors = placeholder.validateConfig(config);
  if (errors.length > 0) {
    throw new Error(fmt('init_provider_config_invalid', errors.join('; ')));
  }
  return { id, type, adapterPackage, config };
}

/**
 * Parses a recovery-style bootstrap spec — adapter flags only, with no
 * type or id embedded. Provider type comes from the separate `--provider
 * <type>` flag; id is hardcoded (`recovery-bootstrap`) because the bootstrap
 * provider exists only for the duration of the recovery and never persists.
 *
 * Grammar: `[adapter-flags]` tokenized shell-style — the entire spec is the
 * `rawArgs` array passed to `configureFromFlags`. Empty spec, unknown
 * provider type, or adapter rejection raise distinct localized errors.
 *
 * @param bootstrapSpec - raw value of `--bootstrap`
 * @param providerType  - value of `--provider`
 * @param cwd           - BFS working directory, exposed via `io.workDir`
 * @throws Error when the spec is empty, the type is unknown, or the adapter
 *         rejects the resulting configuration
 */
export async function parseRecoveryBootstrapSpec(bootstrapSpec: string, providerType: string, cwd: string): Promise<RecoveryBootstrapSpec> {
  const tokens = shellParse(bootstrapSpec);
  if (tokens.length === 0) {
    throw new Error(fmt('recovery_bootstrap_empty', bootstrapSpec));
  }
  const factory = providerRegistry.getFactory(providerType);
  if (!factory) {
    throw new Error(fmt('recovery_provider_type_unknown', providerType));
  }
  const meta = providerRegistry.getMeta(providerType);
  const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
  const io = createCliProviderIO(cwd);
  const placeholder = factory.create({ id: 'recovery-bootstrap', type: providerType, adapterPackage, config: {} }, io);
  const config = await placeholder.configureFromFlags({ name: 'recovery-bootstrap', rawArgs: tokens });
  const errors = placeholder.validateConfig(config);
  if (errors.length > 0) {
    throw new Error(fmt('recovery_bootstrap_config_invalid', errors.join('; ')));
  }
  return { adapterPackage, config };
}
