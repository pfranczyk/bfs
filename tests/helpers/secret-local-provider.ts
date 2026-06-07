import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';

/**
 * Test-only provider type backed by local disk that declares a secret field.
 * The built-in local provider has no secrets, and FTP needs a server, so this
 * is how secret stripping / interactive re-supply becomes observable in unit
 * tests.
 */
export const SECRET_TYPE = 'local-secret-test';

export class SecretLocalProvider extends LocalFsProvider {
  getSecretFields(): readonly string[] {
    return ['password'];
  }
}

/** Registers SECRET_TYPE in the global registry. Call in beforeEach. */
export function registerSecretProvider(): void {
  providerRegistry.register(SECRET_TYPE, {
    lang: 'en',
    displayName: 'Local secret (tests)',
    create: (config: ProviderConfig, io: ProviderIO) => new SecretLocalProvider(config, io),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

/** Drops SECRET_TYPE from the singleton registry. Call in afterEach. */
export function unregisterSecretProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(SECRET_TYPE);
}

/** A provider config for SECRET_TYPE with a per-id password. */
export function secretProviderConfig(id: string, dir: string): ProviderConfig {
  return { id, type: SECRET_TYPE, adapterPackage: null, config: { path: dir, password: `pw-${id}` } };
}
