import { providerRegistry } from '../providers/provider.js';
import type { ProviderIO, ShardLocation } from '../types/index.js';

/** Recursively sorts object keys so two structurally-equal values stringify
 * identically regardless of key insertion order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** Canonical JSON (sorted keys) for order-independent equality of map entries. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Returns the shard_index values whose location-map entries differ between two
 * maps (provider_type, connection_config, required_inputs, remote_path). Only
 * indices present in BOTH maps are compared. Every shard in a version carries
 * the identical location map, so any per-entry divergence between two shards of
 * the same version signals a forged (unencrypted) map — used by recovery
 * consensus to detect a redirected provider. Returns [] when the maps agree.
 *
 * @param a - one shard's location map
 * @param b - another shard's location map (same version)
 * @returns shard_index values that diverge between the two maps
 */
export function divergentShardIndices(a: ShardLocation[], b: ShardLocation[]): number[] {
  const byIndex = new Map(b.map((entry) => [entry.shard_index, entry]));
  const diverged: number[] = [];
  for (const ea of a) {
    const eb = byIndex.get(ea.shard_index);
    if (!eb) continue; // index only on one side — different shard set, not a per-entry forgery
    const differs =
      ea.provider_type !== eb.provider_type || ea.remote_path !== eb.remote_path || canonical(ea.required_inputs ?? []) !== canonical(eb.required_inputs ?? []) || canonical(ea.connection_config) !== canonical(eb.connection_config);
    if (differs) diverged.push(ea.shard_index);
  }
  return diverged;
}

/**
 * Returns the secret field names an adapter of the given type declares. The
 * adapter reports them via {@link StorageProvider.getSecretFields}, which is a
 * pure declaration (no I/O), so a throwaway instance with an empty config is
 * enough to read it. Returns an empty array for unknown types — an unregistered
 * adapter's secrets cannot be known, so nothing is stripped.
 *
 * @returns the adapter's declared secret field names, or [] for unknown types
 */
export function secretFieldsForType(type: string, io: ProviderIO): readonly string[] {
  if (!providerRegistry.has(type)) return [];
  const placeholder = providerRegistry.create({ id: '', type, adapterPackage: null, config: {} }, io);
  return placeholder.getSecretFields();
}

/** True when a config value is actually set (non-empty), not just declared. */
function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return value !== undefined && value !== null;
}

/**
 * Splits a provider connection config into the part embedded in a shard
 * location map and the list of inputs the operator must supply at recovery.
 *
 * Secrets (FTP password, future SSH key/passphrase) must never travel in shard
 * headers: anyone holding a single shard would read every provider's
 * credentials. So the adapter's declared secret fields are removed from
 * `connection_config`, and the names of those that were actually set are
 * returned in `required_inputs`. Non-secret coordinates (host, port, user,
 * path) stay so one shard can still discover and reach the rest.
 *
 * `required_inputs` lets disaster recovery act deterministically without
 * blind connection attempts: `[]` means the resource needs no secret (e.g.
 * anonymous FTP — never prompt), a non-empty list names exactly what to ask
 * for. The input config is never mutated.
 *
 * @returns the stripped config plus the names of required (stripped) inputs
 */
export function splitLocationSecrets(type: string, config: Record<string, unknown>, io: ProviderIO): { connection_config: Record<string, unknown>; required_inputs: string[] } {
  const secretFields = secretFieldsForType(type, io);
  const connection_config: Record<string, unknown> = {};
  const required_inputs: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!secretFields.includes(key)) {
      connection_config[key] = value;
      continue;
    }
    // Secret field: strip the value; record the name only if it was set, so a
    // guest/anonymous resource (no value) does not demand an input at recovery.
    if (hasValue(value)) required_inputs.push(key);
  }
  return { connection_config, required_inputs };
}
