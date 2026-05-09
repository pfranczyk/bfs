/**
 * Public entry point for third-party BFS provider adapters.
 *
 * External adapter packages (e.g. `bfs-provider-s3`) install BFS as an npm
 * dependency and import the contract from this module:
 *
 * ```ts
 * import {
 *   type StorageProvider,
 *   type ProviderFactory,
 *   type ProviderIO,
 *   providerRegistry,
 *   BFS_PROVIDER_API_VERSION,
 *   ProviderError,
 * } from 'bfs-vault/provider';
 * ```
 *
 * Stability contract: anything re-exported here is part of the public API
 * covered by `BFS_PROVIDER_API_VERSION`. Breaking changes bump that
 * integer; see {@link ./version.ts} for history.
 */

// Error classes — adapters throw these so CLI surfaces them consistently.
export {
  BfsError,
  DecryptionError,
  ProviderError,
  ShardCorruptedError,
  TamperDetectedError,
} from './core/errors.js';

// Factory & registry.
export {
  type ProviderFactory,
  ProviderRegistry,
  providerRegistry,
} from './providers/provider.js';
// Types & interfaces — the provider contract.
export type {
  AdapterRegistrationMeta,
  CliProviderInput,
  ProviderConfig,
  ProviderHelp,
  ProviderHelpFlag,
  ProviderIO,
  RemoteRef,
  StorageProvider,
} from './types/index.js';

// Version numbers.
export { BFS_PROVIDER_API_VERSION, BFS_VERSION } from './version.js';
