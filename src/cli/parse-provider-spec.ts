import { fmt, t } from '../i18n/index.js';
import { createCliProviderIO, providerRegistry, validateProviderId } from '../providers/provider.js';
import type { ProviderConfig, RepairPair } from '../types/index.js';
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
  if (!providerRegistry.getFactory(type)) {
    throw new Error(fmt('init_provider_format_invalid', spec));
  }

  // After the first colon the entire head is the id. The charset regex
  // forbids further `:`, whitespace, or quote chars — multi-segment forms
  // like `local:id:/path` fail validation with init_provider_format_invalid.
  const id = head.slice(firstColon + 1);
  validateProviderId(id);
  return buildProviderConfigFromFlags(type, id, tokens.slice(1), cwd);
}

/**
 * Asserts that provider ids are unique — both within `newIds` and against any
 * already-registered `existingConfigIds`. Shared by every command that
 * introduces a provider id (init, add, edit) so a duplicate cannot reach
 * `.bfs/config.json`, where a lookup silently resolves to the first match and
 * orphans the rest.
 *
 * @param newIds            ids being introduced (e.g. all `--provider` ids at init)
 * @param existingConfigIds ids already present in the backup config; empty at init
 * @throws Error when an id repeats within `newIds` or collides with an existing id
 */
export function validateProviderIdsUnique(newIds: string[], existingConfigIds: string[] = []): void {
  const existing = new Set(existingConfigIds);
  const seen = new Set<string>();
  for (const id of newIds) {
    if (existing.has(id)) {
      throw new Error(fmt('provider_add_exists', id));
    }
    if (seen.has(id)) {
      throw new Error(fmt('provider_id_duplicate_in_args', id));
    }
    seen.add(id);
  }
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

/** A repair pair after classification, before its migration config is built. */
interface RepairPairDraft {
  readonly oldName: string;
  readonly params: string;
  readonly rawParams: string[];
  readonly migration: Nullable<{ type: string; name: string; args: string[] }>;
}

/**
 * Parses the variadic `<name> "<params>" ...` tail of `bfs repair` into
 * classified pairs. Chunks the flat positional array into pairs, rejects an
 * odd count, verifies each `<name>` exists in the backup and appears once, and
 * classifies each params string: a `type:name <flags>` prefix (registered
 * type) is a migration whose target config is built and validated; a flag-only
 * or empty string is an in-place edit. Migration target ids are checked for
 * collisions (with existing ids and with each other) via
 * {@link validateProviderIdsUnique} before any adapter config is built.
 *
 * @param positional        flat `[name1, params1, name2, params2, ...]` tail
 * @param existingConfigIds provider ids already present in `.bfs/config.json`
 * @param cwd               BFS working directory, exposed to adapters via `io.workDir`
 * @returns one {@link RepairPair} per `<name> "<params>"` pair, in input order
 * @throws Error on odd count, unknown/duplicate name, invalid params, or id conflict
 */
export async function parseRepairSpec(positional: string[], existingConfigIds: string[], cwd: string): Promise<RepairPair[]> {
  if (positional.length === 0 || positional.length % 2 !== 0) throw new Error(t('repair_spec_odd_args'));

  const draft = classifyRepairPairs(positional, existingConfigIds);
  // Reject migration-target id collisions (with existing ids or between pairs)
  // before any adapter config is built — the cheap structural checks fail fast.
  validateProviderIdsUnique(
    draft.flatMap((d) => (d.migration ? [d.migration.name] : [])),
    existingConfigIds,
  );
  return Promise.all(draft.map((d) => buildRepairPair(d, cwd)));
}

/** Pass 1: chunk the flat array into pairs, validate names, classify edit vs migration. */
function classifyRepairPairs(positional: string[], existingConfigIds: string[]): RepairPairDraft[] {
  const existing = new Set(existingConfigIds);
  const seen = new Set<string>();
  const draft: RepairPairDraft[] = [];
  for (let i = 0; i < positional.length; i += 2) {
    const oldName = positional[i];
    const params = positional[i + 1];
    if (!existing.has(oldName)) throw new Error(fmt('repair_unknown_provider', oldName));
    if (seen.has(oldName)) throw new Error(fmt('repair_duplicate_provider_in_args', oldName));
    seen.add(oldName);
    const rawParams = shellParse(params);
    const migration = classifyMigration(rawParams);
    if (migration) validateProviderId(migration.name);
    draft.push({ oldName, params, rawParams, migration });
  }
  return draft;
}

/** Pass 2: build (and validate) a migration's target config; an edit carries a null config. */
async function buildRepairPair(d: RepairPairDraft, cwd: string): Promise<RepairPair> {
  const shared = { oldName: d.oldName, params: d.params, rawParams: d.rawParams };
  if (!d.migration) return { ...shared, isMigration: false, newConfig: null };
  const newConfig = await buildProviderConfigFromFlags(d.migration.type, d.migration.name, d.migration.args, cwd);
  return { ...shared, isMigration: true, newConfig };
}

/**
 * Classifies params tokens as a `type:name <flags>` migration or an edit.
 * Returns the parsed migration when the head is a non-flag `type:name` with a
 * registered provider type; null for flag-only or empty params (an in-place
 * edit); throws when the head is a bare word that is neither a flag nor a valid
 * migration prefix.
 */
function classifyMigration(rawParams: string[]): Nullable<{ type: string; name: string; args: string[] }> {
  const head = rawParams[0];
  if (head === undefined || head.startsWith('-')) return null; // flag edit or no-op
  const colon = head.indexOf(':');
  if (colon > 0 && colon < head.length - 1 && providerRegistry.getFactory(head.slice(0, colon))) {
    return { type: head.slice(0, colon), name: head.slice(colon + 1), args: rawParams.slice(1) };
  }
  throw new Error(fmt('repair_spec_invalid_params', rawParams.join(' ')));
}

/**
 * Builds and structurally validates a `ProviderConfig` from a type, id and raw
 * adapter flags. Shared by init-style and repair-migration spec parsing so the
 * adapter's own flag grammar (`configureFromFlags`) and structural validation
 * (`validateConfig`) run identically wherever a provider is introduced.
 *
 * @throws Error when the type is unregistered or the adapter rejects the config
 */
async function buildProviderConfigFromFlags(type: string, id: string, rawArgs: string[], cwd: string): Promise<ProviderConfig> {
  const factory = providerRegistry.getFactory(type);
  if (!factory) throw new Error(fmt('init_provider_format_invalid', `${type}:${id}`));
  const meta = providerRegistry.getMeta(type);
  const adapterPackage = meta ? `${meta.packageName}@${meta.packageVersion}` : null;
  const io = createCliProviderIO(cwd);
  const placeholder = factory.create({ id, type, adapterPackage, config: {} }, io);
  const config = await placeholder.configureFromFlags({ name: id, rawArgs });
  const errors = placeholder.validateConfig(config);
  if (errors.length > 0) throw new Error(fmt('init_provider_config_invalid', errors.join('; ')));
  return { id, type, adapterPackage, config };
}
