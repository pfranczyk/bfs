import { VaultCollisionError } from '../core/errors.js';
import { readShardHeader } from '../core/shard-io.js';
import { fmt } from '../i18n/index.js';
import type { ProviderIO, RemoteRef, ShardHeader, StorageProvider } from '../types/index.js';
import { parseVersionFromFilename } from './bootstrap.js';

/**
 * Reads a shard header, returning null instead of throwing when it cannot be
 * parsed. `vault_id` lives in the plaintext part of the header, so no vault key
 * is needed; an unreadable header simply yields no proof of ownership.
 */
async function tryReadHeader(provider: StorageProvider, ref: RemoteRef): Promise<Nullable<ShardHeader>> {
  try {
    return await readShardHeader(provider, ref);
  } catch {
    return null;
  }
}

/**
 * Aborts with VaultCollisionError when `provider`'s vault sub-directory already
 * holds shards belonging to a DIFFERENT backup, so a write never silently
 * overwrites another machine's shards. `setVaultName` scopes the listing to the
 * vault sub-directory, so a location holding a differently-named backup never
 * collides.
 *
 * `expectedVaultId === null` (a fresh `init`, which has no vault_id yet): ANY
 * shard present is foreign - abort on presence. Otherwise (`push` /
 * `provider add`): only a readable header whose `vault_id` differs from
 * `expectedVaultId` is a collision. A location holding our OWN shards (matching
 * vault_id) is ours and passes - this is the normal versioned re-push. When
 * shards exist but no header is readable, there is no proof of foreignness, so
 * the write proceeds: the owner may be overwriting a damaged copy of their own
 * backup rather than being locked out of it.
 *
 * @param provider        Provider to scan (does not require prior authenticate)
 * @param vaultName       Vault sub-directory name to scan
 * @param expectedVaultId Our vault_id, or null for a fresh init
 * @param io              ProviderIO (foreign vault_id is logged via io.debug)
 * @throws VaultCollisionError when a foreign backup occupies the location
 */
export async function assertNoForeignVault(provider: StorageProvider, vaultName: string, expectedVaultId: Nullable<string>, io: ProviderIO): Promise<void> {
  provider.setVaultName(vaultName);
  let shardRefs: RemoteRef[];
  try {
    shardRefs = (await provider.list('shard_')).filter((ref) => parseVersionFromFilename(ref.path) !== null);
  } catch (err) {
    // The location cannot be listed (path missing, not a directory, transport
    // error). That is not proof of a foreign vault, so let the operation proceed
    // - its own error handling stays intact (e.g. a failing upload -> degraded
    // push, which the collision guard must not pre-empt). LocalFsProvider.list()
    // returns [] on ENOENT but throws on ENOTDIR (a vault path that is a file),
    // and that throw must not abort the caller.
    io.debug(`vault collision guard: cannot list provider "${provider.id}" (${err instanceof Error ? err.message : String(err)}) - proceeding, no proof of a foreign vault`);
    return;
  }
  if (shardRefs.length === 0) return;

  if (expectedVaultId === null) {
    // Fresh init: any real shard in the freshly-named sub-directory belongs to
    // another backup - abort on presence. The header read is best-effort and
    // only enriches the debug diagnostic.
    const header = await tryReadHeader(provider, shardRefs[0]);
    io.debug(`vault collision at provider "${provider.id}": ${shardRefs.length} shard(s) present, foreign vault_id=${header?.vault_id ?? 'unreadable'}`);
    throw new VaultCollisionError(fmt('vault_collision_detected', provider.id), provider.id);
  }

  for (const ref of shardRefs) {
    const header = await tryReadHeader(provider, ref);
    if (header === null) continue; // unreadable - no proof of foreignness from this shard
    if (header.vault_id === expectedVaultId) return; // our own shard - this location is ours
    io.debug(`vault collision at provider "${provider.id}": foreign vault_id=${header.vault_id}`);
    throw new VaultCollisionError(fmt('vault_collision_detected', provider.id), provider.id);
  }
  // Every shard header was unreadable: no proof of a foreign vault, so let the
  // owner proceed - they may be overwriting a damaged copy of their own backup.
}
