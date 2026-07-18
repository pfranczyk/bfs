import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, RemoteRef, ShardLocation } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { updateLocationMaps } from '../../src/vault/heal.js';
import { init, push } from '../../src/vault/vault-manager.js';

// updateLocationMaps rewrites every sibling shard's header with a new location
// map after a relocate/rebuild. Its loop catches ALL errors as "skip unavailable
// providers", so a provider that is REACHABLE but whose header write fails (disk
// full, read-only remount, transient 5xx) is skipped silently — leaving that
// shard's map stale with no signal, indistinguishable from a genuinely-down
// provider. This guards that a post-authenticate failure is surfaced, while a
// truly unreachable provider is still skipped quietly.

const HDR_FAIL_TYPE = 'hdr-write-fails-test';
const TOGGLE_TYPE = 'toggle-auth-test';
let authUnreachable = false;

/** Local-disk provider that authenticates fine but fails the header sidecar write. */
class HeaderWriteFailsProvider extends LocalFsProvider {
  async uploadHeaderSidecar(_ref: RemoteRef, _bytes: Buffer): Promise<void> {
    throw new ProviderError('sidecar write failed (test): read-only medium');
  }
}

/** Local-disk provider reachable at push time whose authenticate() can be toggled to fail — models a provider that goes down before the later heal. */
class ToggleAuthProvider extends LocalFsProvider {
  async authenticate(): Promise<void> {
    if (authUnreachable) throw new ProviderError('unreachable (test)');
    return super.authenticate();
  }
}

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function provider(id: string, type: string, dir: string): ProviderConfig {
  return { id, type, adapterPackage: null, config: { path: dir } };
}

describe('updateLocationMaps surfaces a header write failure on a reachable provider', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-heal-warn-root-');
    pdirs = [await mkTmp('bfs-heal-warn-p0-'), await mkTmp('bfs-heal-warn-p1-'), await mkTmp('bfs-heal-warn-p2-')];
    authUnreachable = false;
    providerRegistry.register(HDR_FAIL_TYPE, {
      lang: 'en',
      displayName: 'Header-write-fails (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new HeaderWriteFailsProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
    providerRegistry.register(TOGGLE_TYPE, {
      lang: 'en',
      displayName: 'Toggle-auth (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new ToggleAuthProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(async () => {
    const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
    entries.delete(HDR_FAIL_TYPE);
    entries.delete(TOGGLE_TYPE);
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should warn when a reachable provider header rewrite fails, not skip it silently', async () => {
    const setupIo = createMockProviderIO({}, root, false).io;
    await fs.writeFile(path.join(root, 'data.txt'), 'payload', 'utf-8');

    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: [provider('p0', 'local', pdirs[0] ?? ''), provider('p1', 'local', pdirs[1] ?? ''), provider('p2', HDR_FAIL_TYPE, pdirs[2] ?? '')],
      push_mode: PushMode.NewVersion,
      io: setupIo,
    });
    await push(root, { io: setupIo });

    const newMap: ShardLocation[] = [0, 1, 2].map((i) => ({
      shard_index: i,
      provider_id: `p${i}`,
      provider_type: i === 2 ? HDR_FAIL_TYPE : 'local',
      adapterPackage: null,
      connection_config: { path: pdirs[i] ?? '' },
      required_inputs: [],
      remote_path: `shard_${i}.bfs.1`,
      shard_hash: 'a'.repeat(64),
    }));

    // p0/p1 rewrite their sidecars fine; p2 authenticates but its header write
    // throws. The failure on the reachable p2 must be surfaced, not swallowed.
    const { io, logs } = createMockProviderIO({}, root, false);
    await updateLocationMaps(root, 1, { newLocationMap: newMap, io });

    const warned = logs.some((l) => l.level === 'warn' && l.message.includes('p2'));
    expect(warned).toBe(true);
  });

  it('should still skip an UNREACHABLE provider silently (no warn when authenticate fails)', async () => {
    const setupIo = createMockProviderIO({}, root, false).io;
    await fs.writeFile(path.join(root, 'data.txt'), 'payload', 'utf-8');

    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: [provider('p0', 'local', pdirs[0] ?? ''), provider('p1', 'local', pdirs[1] ?? ''), provider('p2', TOGGLE_TYPE, pdirs[2] ?? '')],
      push_mode: PushMode.NewVersion,
      io: setupIo,
    });
    await push(root, { io: setupIo }); // p2 reachable here — push succeeds

    // p2 goes down before the heal: authenticate() now throws. This is the
    // "unavailable provider" case that MUST stay a quiet skip — the warn is
    // reserved for a reachable provider whose write fails (test above).
    authUnreachable = true;

    const newMap: ShardLocation[] = [0, 1, 2].map((i) => ({
      shard_index: i,
      provider_id: `p${i}`,
      provider_type: i === 2 ? TOGGLE_TYPE : 'local',
      adapterPackage: null,
      connection_config: { path: pdirs[i] ?? '' },
      required_inputs: [],
      remote_path: `shard_${i}.bfs.1`,
      shard_hash: 'a'.repeat(64),
    }));

    const { io, logs } = createMockProviderIO({}, root, false);
    await updateLocationMaps(root, 1, { newLocationMap: newMap, io });

    expect(logs.some((l) => l.level === 'warn')).toBe(false);
  });
});
