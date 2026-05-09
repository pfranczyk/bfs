import { afterEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { disableDebug, enableDebug } from '../../src/debug.js';
import {
  createCliProviderIO,
  createMockProviderIO,
  validateProviderId,
} from '../../src/providers/provider.js';

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
