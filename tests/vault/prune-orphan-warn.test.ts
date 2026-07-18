import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { init, prune, push } from '../../src/vault/vault-manager.js';

// prune deletes a pruned version's remote data best-effort. A genuine delete
// failure (permissions, unreachable medium — distinct from the host-key gate
// fixed separately) is swallowed by the loop's catch, so the data is orphaned on
// the medium with NO signal to the operator. This guards that prune surfaces such
// a failure through its ProviderIO instead of failing silently.

const FAIL_TYPE = 'delete-fails-test';

/** Local-disk provider whose delete() always fails, modelling an unreachable or read-only medium. */
class DeleteFailsProvider extends LocalFsProvider {
  async delete(): Promise<void> {
    throw new ProviderError('delete failed (test): permission denied');
  }
}

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function provider(id: string, type: string, dir: string): ProviderConfig {
  return { id, type, adapterPackage: null, config: { path: dir } };
}

describe('prune surfaces a best-effort delete failure', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-prune-warn-root-');
    pdirs = [await mkTmp('bfs-prune-warn-p0-'), await mkTmp('bfs-prune-warn-p1-'), await mkTmp('bfs-prune-warn-p2-')];
    providerRegistry.register(FAIL_TYPE, {
      lang: 'en',
      displayName: 'Delete-fails (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new DeleteFailsProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAIL_TYPE);
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should warn (not silently swallow) when a pruned shard cannot be deleted', async () => {
    const setupIo = createMockProviderIO({}, root, false).io;
    await fs.writeFile(path.join(root, 'data.txt'), 'payload', 'utf-8');

    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: [provider('p0', 'local', pdirs[0] ?? ''), provider('p1', 'local', pdirs[1] ?? ''), provider('p2', FAIL_TYPE, pdirs[2] ?? '')],
      push_mode: PushMode.NewVersion,
      io: setupIo,
    });
    await push(root, { io: setupIo }); // v1
    await push(root, { io: setupIo }); // v2 — a version survives after pruning v1

    // Prune v1 with an observable IO. p2's delete throws; the loop keeps going
    // (best-effort) but must not swallow the failure silently.
    const { io, logs } = createMockProviderIO({}, root, false);
    await prune(root, { versions: [1], io });

    // The pruned manifest is gone (prune completed) and the failure was surfaced.
    expect(await readManifest(root, 1)).toBeNull();
    const warned = logs.some((l) => l.level === 'warn' && l.message.includes('p2'));
    expect(warned).toBe(true);
  });
});
