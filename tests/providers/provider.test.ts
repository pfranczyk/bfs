import { afterEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { disableDebug, enableDebug } from '../../src/debug.js';
import { createCliProviderIO, createMockProviderIO, type ProviderFactory, ProviderRegistry, validateProviderId } from '../../src/providers/provider.js';
import type { ProviderConfig, StorageProvider } from '../../src/types/index.js';

describe('validateProviderId', () => {
  it('should accept letters, digits, dot, underscore and dash', () => {
    expect(() => validateProviderId('nas-1')).not.toThrow();
    expect(() => validateProviderId('usb_drive')).not.toThrow();
    expect(() => validateProviderId('archive.2026')).not.toThrow();
    expect(() => validateProviderId('ABC-def_9.9')).not.toThrow();
  });

  it('should throw BfsError on empty id', () => {
    expect(() => validateProviderId('')).toThrow(BfsError);
  });

  it('should throw BfsError on whitespace', () => {
    expect(() => validateProviderId('nas 1')).toThrow(BfsError);
    expect(() => validateProviderId('my nas')).toThrow(BfsError);
    expect(() => validateProviderId(' leading')).toThrow(BfsError);
    expect(() => validateProviderId('trailing ')).toThrow(BfsError);
  });

  it('should throw BfsError on forbidden punctuation', () => {
    expect(() => validateProviderId('nas:1')).toThrow(BfsError);
    expect(() => validateProviderId('nas/1')).toThrow(BfsError);
    expect(() => validateProviderId('nas\\1')).toThrow(BfsError);
    expect(() => validateProviderId('"nas"')).toThrow(BfsError);
    expect(() => validateProviderId('a,b')).toThrow(BfsError);
  });

  it('should include the offending id in the error message', () => {
    expect(() => validateProviderId('my nas')).toThrow(/my nas/);
  });
});

describe('createMockProviderIO', () => {
  it('should capture debug() output as a log entry tagged level "debug"', () => {
    const { io, logs } = createMockProviderIO();

    io.debug('first');
    io.info('second');
    io.debug('third');

    expect(logs).toEqual([
      { level: 'debug', message: 'first' },
      { level: 'info', message: 'second' },
      { level: 'debug', message: 'third' },
    ]);
  });
});

describe('ProviderRegistry.create — provider API completeness guard', () => {
  function fakeConfig(type: string): ProviderConfig {
    return { id: 'x', type, adapterPackage: null, config: {} };
  }

  function factory(create: ProviderFactory['create']): ProviderFactory {
    return { lang: 'en', displayName: 'Test', create, help: () => ({ usage: '', description: '', flags: [], examples: [] }) };
  }

  it('should throw BfsError when the created instance lacks a method from the current API', () => {
    const registry = new ProviderRegistry();
    // An adapter compiled against API v1: it declares no requiresApiVersion (so
    // it clears the registration version gate, since 1 > current is false) yet
    // returns an instance without verifyShard. The guard must catch this at create().
    registry.register(
      'legacy',
      factory(
        () =>
          ({
            usesSidecar: () => false,
            uploadHeaderSidecar: async () => {},
            downloadHeaderSidecar: async () => null,
            // verifyShard intentionally absent — predates provider API v2
          }) as unknown as StorageProvider,
      ),
    );
    const { io } = createMockProviderIO();

    expect(() => registry.create(fakeConfig('legacy'), io)).toThrow(BfsError);
  });

  it('should return the instance when every required method is present', () => {
    const registry = new ProviderRegistry();
    registry.register(
      'complete',
      factory(() => ({ usesSidecar: () => false, uploadHeaderSidecar: async () => {}, downloadHeaderSidecar: async () => null, verifyShard: async () => ({ ok: true }) }) as unknown as StorageProvider),
    );
    const { io } = createMockProviderIO();

    const provider = registry.create(fakeConfig('complete'), io);

    expect(typeof provider.verifyShard).toBe('function');
  });
});

describe('createCliProviderIO.debug', () => {
  afterEach(() => {
    disableDebug();
    vi.restoreAllMocks();
  });

  it('should be silent when --debug is inactive', () => {
    disableDebug();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const io = createCliProviderIO('/tmp');

    io.debug('connection chatter');

    expect(errSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('should write to stderr when --debug is active', () => {
    enableDebug();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const io = createCliProviderIO('/tmp');

    io.debug('connection chatter');

    expect(errSpy).toHaveBeenCalledWith('connection chatter');
  });
});
