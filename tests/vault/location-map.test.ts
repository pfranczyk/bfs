import { describe, expect, it } from 'vitest';
// Side-effect imports register the local + ftp built-ins with the global registry.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { secretFieldsForType, splitLocationSecrets } from '../../src/vault/location-map.js';

const { io } = createMockProviderIO();

describe('secretFieldsForType', () => {
  it('should report password as the FTP secret field', () => {
    expect(secretFieldsForType('ftp', io)).toEqual(['password']);
  });

  it('should report no secret fields for local-fs', () => {
    expect(secretFieldsForType('local', io)).toEqual([]);
  });

  it('should return empty for an unknown provider type', () => {
    expect(secretFieldsForType('does-not-exist', io)).toEqual([]);
  });
});

describe('splitLocationSecrets', () => {
  it('should strip the FTP password value and report it as a required input', () => {
    const config = { host: 'ftp.example.com', port: 21, user: 'bob', password: 's3cret', path: '/backup', secure: false };

    const { connection_config, required_inputs } = splitLocationSecrets('ftp', config, io);

    expect(connection_config).toEqual({ host: 'ftp.example.com', port: 21, user: 'bob', path: '/backup', secure: false });
    expect(required_inputs).toEqual(['password']);
  });

  it('should report no required input for an anonymous FTP (password not set)', () => {
    const config = { host: 'ftp.example.com', user: 'anonymous', path: '/pub', password: '' };

    const { connection_config, required_inputs } = splitLocationSecrets('ftp', config, io);

    expect(connection_config).toEqual({ host: 'ftp.example.com', user: 'anonymous', path: '/pub' });
    expect(required_inputs).toEqual([]);
  });

  it('should not mutate the input config', () => {
    const config = { host: 'ftp.example.com', password: 's3cret' };

    splitLocationSecrets('ftp', config, io);

    expect(config.password).toBe('s3cret');
  });

  it('should leave a local-fs config unchanged with no required inputs', () => {
    const config = { path: '/mnt/disk' };

    const { connection_config, required_inputs } = splitLocationSecrets('local', config, io);

    expect(connection_config).toEqual({ path: '/mnt/disk' });
    expect(required_inputs).toEqual([]);
  });

  it('should preserve unknown non-secret fields', () => {
    const config = { host: 'h', password: 'p', customField: 42 };

    const { connection_config, required_inputs } = splitLocationSecrets('ftp', config, io);

    expect(connection_config).toEqual({ host: 'h', customField: 42 });
    expect(required_inputs).toEqual(['password']);
  });

  it('should return a fresh copy with no required inputs for an unknown type', () => {
    const config = { token: 'abc' };

    const { connection_config, required_inputs } = splitLocationSecrets('mystery-type', config, io);

    expect(connection_config).toEqual({ token: 'abc' });
    expect(connection_config).not.toBe(config);
    expect(required_inputs).toEqual([]);
  });
});
