import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { recover } from '../../src/vault/recovery.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { registerSecretProvider, SecretLocalProvider, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

beforeEach(() => {
  registerSecretProvider();
});

afterEach(() => {
  unregisterSecretProvider();
});

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-strip-'));
}

const secretProvider = secretProviderConfig;

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

describe('push location map secret stripping', () => {
  it('should strip the provider secret from the shard location map but keep it in config.json', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await push(root, { io: mockIO() });

    // The embedded location map (plaintext, vault is unencrypted) must NOT
    // carry the password, but must keep the non-secret coordinates.
    const shardBytes = await fs.readFile(path.join(dirs[0] ?? '', 'strip', 'shard_0.bfs.1'));
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBytes));
    payloadStream.on('error', () => {}).destroy();

    expect(header.location_map).toHaveLength(3);
    for (const loc of header.location_map) {
      expect(loc.connection_config.password).toBeUndefined();
      expect(loc.connection_config.path).toBeDefined();
      expect(loc.required_inputs).toEqual(['password']);
    }

    // config.json keeps the secret locally (protected by 0600 from K1).
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['pw-p0', 'pw-p1', 'pw-p2']);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push unencrypted warning', () => {
  it('should warn that the backup is not encrypted on every unencrypted push', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'plain',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const { io, logs } = createMockProviderIO();
    await push(root, { io });

    expect(logs.some((l) => l.level === 'warn' && /NOT encrypted/.test(l.message))).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('recovery with a stripped location map', () => {
  async function setupStrippedVault(root: string, dirs: string[], io: ProviderIO): Promise<void> {
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await push(root, { io });
    // Disaster: lose the local vault metadata. The remote shards carry a
    // stripped map, so recovery must obtain each provider's transport secret.
    await fs.rm(path.join(root, '.bfs'), { recursive: true });
  }

  it('should reuse the bootstrap secret for sibling providers without prompting', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No interactive answers: every provider must connect from the seeded pool.
    const { io } = createMockProviderIO();
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io, bootstrapInputs: { password: 'shared-key' } });

    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['shared-key', 'shared-key', 'shared-key']);
    expect(config?.providers.map((p) => p.config.path)).toEqual(dirs);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should prompt for a missing secret, pool it for the next provider, and degrade the unanswered one', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No seed; only p1 has an answer. p2 must reuse it from the pool (one
    // prompt), and p0 (no answer) degrades to an absent secret in config.json.
    const answers: Record<string, string> = { [fmt('recovery_ask_transport_password', 'password', 'p1')]: 'typed-key' };
    const { io } = createMockProviderIO(answers);
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io });

    const config = await readConfig(root);
    const passwordById = new Map(config?.providers.map((p) => [p.id, p.config.password]));
    expect(passwordById.get('p0')).toBeUndefined();
    expect(passwordById.get('p1')).toBe('typed-key');
    expect(passwordById.get('p2')).toBe('typed-key');

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});
