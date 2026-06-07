import { providerRegistry } from '../providers/provider.js';
import type { ProviderIO } from '../types/index.js';

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
