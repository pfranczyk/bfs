import { describe, expect, it } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import type { ProviderConfig, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { assertSchemeValid } from '../../src/vault/config.js';

function makeProvider(id: string): ProviderConfig {
  return {
    id,
    type: 'local',
    adapterPackage: null,
    config: { path: `/mnt/${id}` },
  };
}

function makeConfig(
  overrides: Partial<VaultConfig> & {
    scheme?: unknown;
  } = {},
): VaultConfig {
  const base: VaultConfig = {
    vault_id: 'v1',
    vault_name: 'test',
    version: 1,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: {
      enabled: false,
      algorithm: 'aes-256-gcm',
      kdf: 'argon2id',
    },
    compression: { enabled: true, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers: [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')],
  };
  return { ...base, ...(overrides as VaultConfig) };
}

describe('assertSchemeValid', () => {
  it('should accept a valid config (N=2, K=1, 3 providers)', () => {
    expect(() => assertSchemeValid(makeConfig())).not.toThrow();
  });

  it('should accept a valid config (N=4, K=2, 6 providers)', () => {
    const providers = ['a', 'b', 'c', 'd', 'e', 'f'].map(makeProvider);
    const cfg = makeConfig({
      scheme: { data_shards: 4, parity_shards: 2 },
      providers,
    });
    expect(() => assertSchemeValid(cfg)).not.toThrow();
  });

  it('should throw BfsError when scheme is missing', () => {
    const cfg = makeConfig({
      scheme: null as unknown as VaultConfig['scheme'],
    });
    expect(() => assertSchemeValid(cfg)).toThrow(BfsError);
    expect(() => assertSchemeValid(cfg)).toThrow(/missing or corrupted/);
  });

  it('should throw BfsError when data_shards is null', () => {
    const cfg = makeConfig({
      scheme: {
        data_shards: null as unknown as number,
        parity_shards: 1,
      },
    });
    expect(() => assertSchemeValid(cfg)).toThrow(BfsError);
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when data_shards is < 2', () => {
    const cfg = makeConfig({ scheme: { data_shards: 1, parity_shards: 1 } });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when data_shards is not integer', () => {
    const cfg = makeConfig({
      scheme: { data_shards: 2.5, parity_shards: 1 },
    });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when parity_shards is null', () => {
    const cfg = makeConfig({
      scheme: {
        data_shards: 2,
        parity_shards: null as unknown as number,
      },
    });
    expect(() => assertSchemeValid(cfg)).toThrow(/parity_shards must be/);
  });

  it('should throw BfsError when parity_shards is < 1', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: 0 } });
    expect(() => assertSchemeValid(cfg)).toThrow(/parity_shards must be/);
  });

  it('should throw BfsError when providers.length != N+K', () => {
    const cfg = makeConfig({
      scheme: { data_shards: 2, parity_shards: 1 },
      providers: [makeProvider('p1'), makeProvider('p2')],
    });
    expect(() => assertSchemeValid(cfg)).toThrow(/requires 3 providers/);
  });

  it('should mention required provider count and current count', () => {
    const cfg = makeConfig({
      scheme: { data_shards: 3, parity_shards: 2 },
      providers: [makeProvider('p1')],
    });
    expect(() => assertSchemeValid(cfg)).toThrow(/5 providers.*configured: 1/);
  });

  it('should check scheme first (before providers count)', () => {
    // A config that fails BOTH scheme and providers count — should report
    // scheme error first (more specific root cause).
    const cfg = makeConfig({
      scheme: {
        data_shards: null as unknown as number,
        parity_shards: null as unknown as number,
      },
      providers: [],
    });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });
});
