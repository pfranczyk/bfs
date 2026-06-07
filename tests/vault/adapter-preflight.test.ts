import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Side-effect imports register local + ftp built-ins with the global registry.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';

import { ProviderError } from '../../src/core/errors.js';
import { providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig } from '../../src/types/index.js';
import { checkVersionMismatch, detectMissingAdapters, formatMissingAdaptersMessage, missingAdapterError } from '../../src/vault/adapter-preflight.js';

const FAKE_TYPE = 'fake-preflight-type';

function localProvider(id: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: `/tmp/${id}` } };
}

function fakeProvider(id: string, pkgSpec: string | null, type: string = FAKE_TYPE): ProviderConfig {
  return { id, type, adapterPackage: pkgSpec, config: {} };
}

describe('detectMissingAdapters', () => {
  it('should return empty when every type is registered', () => {
    const result = detectMissingAdapters([localProvider('p1'), localProvider('p2')]);
    expect(result).toEqual([]);
  });

  it('should report one MissingAdapter per unique unregistered type', () => {
    const result = detectMissingAdapters([fakeProvider('p1', 'bfs-adapter-x@1.0.0'), fakeProvider('p2', 'bfs-adapter-x@1.0.0')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe(FAKE_TYPE);
    expect(result[0]?.providerIds).toEqual(['p1', 'p2']);
  });

  it('should distinguish built-in (adapterPackage=null) from external', () => {
    const result = detectMissingAdapters([fakeProvider('bin', null, 'not-real-built-in'), fakeProvider('ext', 'bfs-adapter-x@2.0.0')]);
    expect(result).toHaveLength(2);
    const builtIn = result.find((m) => m.adapterPackage === null);
    const external = result.find((m) => m.adapterPackage !== null);
    expect(builtIn?.providerIds).toEqual(['bin']);
    expect(external?.adapterPackage).toBe('bfs-adapter-x@2.0.0');
  });
});

describe('formatMissingAdaptersMessage', () => {
  it('should render one install line per missing external adapter', () => {
    const msg = formatMissingAdaptersMessage([
      { type: 'ssh', adapterPackage: 'bfs-adapter-ssh@1.0.1', providerIds: ['ssh-1'] },
      { type: 'cloud', adapterPackage: '@corp/bfs-adapter-cloud@2.3.0', providerIds: ['c1'] },
    ]);
    expect(msg).toContain('ssh');
    expect(msg).toContain('npm install -g bfs-adapter-ssh@1.0.1');
    expect(msg).toContain('cloud');
    expect(msg).toContain('npm install -g @corp/bfs-adapter-cloud@2.3.0');
  });

  it('should skip built-in missing entries (separate error path)', () => {
    const msg = formatMissingAdaptersMessage([{ type: 'broken-builtin', adapterPackage: null, providerIds: ['x'] }]);
    expect(msg).toBe('');
  });

  it('should mention --allow-missing-adapters as an alternative', () => {
    const msg = formatMissingAdaptersMessage([{ type: 'ssh', adapterPackage: 'bfs-adapter-ssh@1.0.1', providerIds: ['ssh-1'] }]);
    expect(msg).toContain('--allow-missing-adapters');
  });
});

describe('missingAdapterError', () => {
  it('should return a broken-installation error for built-in types', () => {
    const err = missingAdapterError('ftp', null);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/broken/i);
  });

  it('should return an install hint for external adapters', () => {
    const err = missingAdapterError('ssh', 'bfs-adapter-ssh@1.2.3');
    expect(err.message).toContain('npm install -g bfs-adapter-ssh@1.2.3');
  });
});

describe('checkVersionMismatch', () => {
  const FAKE_META_TYPE = 'preflight-fake';

  beforeEach(() => {
    providerRegistry.register(
      FAKE_META_TYPE,
      {
        lang: 'en',
        displayName: 'Fake for tests',
        requiresApiVersion: 1,
        create: () => {
          throw new Error('not used in preflight tests');
        },
        help: () => ({ usage: '', description: 'Fake', flags: [], examples: [] }),
      },
      { packageName: 'bfs-adapter-fake', packageVersion: '1.2.3' },
    );
  });

  afterEach(() => {
    // Registry is a singleton; restore by re-registering with no meta would
    // confuse other tests. Instead, drop the fake entry directly via private
    // access. Vitest isolates files, so leakage between files is bounded.
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAKE_META_TYPE);
  });

  it('should return empty when recorded and installed specs match', () => {
    const result = checkVersionMismatch([{ id: 'ok', type: FAKE_META_TYPE, adapterPackage: 'bfs-adapter-fake@1.2.3', config: {} }]);
    expect(result).toEqual([]);
  });

  it('should flag a major mismatch as strong', () => {
    const result = checkVersionMismatch([{ id: 'upgraded', type: FAKE_META_TYPE, adapterPackage: 'bfs-adapter-fake@0.9.0', config: {} }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe('strong');
  });

  it('should treat minor/patch delta as soft', () => {
    const result = checkVersionMismatch([{ id: 'patched', type: FAKE_META_TYPE, adapterPackage: 'bfs-adapter-fake@1.2.1', config: {} }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe('soft');
  });

  it('should ignore providers with adapterPackage=null (built-in)', () => {
    const result = checkVersionMismatch([localProvider('p1')]);
    expect(result).toEqual([]);
  });
});
