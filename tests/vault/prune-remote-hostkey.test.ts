import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init, prune, push } from '../../src/vault/vault-manager.js';

// Regression for the prune-orphans-remote-shards bug (cli-e2e 90-prune-ssh RED,
// 91-prune-ftp control green). `prune` builds a hardcoded silent ProviderIO with
// `confirm: () => false` and WITHOUT `interactive: false`. A provider that must
// make a host-key trust decision (SSH) therefore takes the interactive path,
// gets a `false` from confirm(), and rejects the connection; the delete throws
// and prune's best-effort `catch {}` swallows it — the shard is orphaned on the
// medium (silent storage leak). FTP has no host-key decision, so it is immune —
// which is exactly why this must be proven at the vault-manager level, not in a
// provider unit: the defect is in how prune drives the IO, not in any provider.

const GATED_TYPE = 'hostkey-gated-test';

/**
 * Local-disk provider that models SSH's host-key trust gate
 * (decideHostKeyTrust in src/providers/ssh.ts). With no pinned fingerprint a
 * non-interactive caller (io.interactive === false) falls back to
 * accept_new_host_key — true here, mirroring the `--accept-new-host-key` the SSH
 * pool passes at init — while an interactive caller is asked via confirm(). A
 * silent IO that neither signals interactive:false nor confirms drives
 * authenticate() into rejection, exactly as a real sshd refuses the connection.
 * delete() stays the real local delete, so whether the shard actually leaves the
 * medium is observable on disk.
 */
class HostKeyGatedProvider extends LocalFsProvider {
  private readonly gateIo: ProviderIO;

  constructor(config: ProviderConfig, io: ProviderIO) {
    super(config, io);
    this.gateIo = io;
  }

  async authenticate(): Promise<void> {
    const trusted = this.gateIo.interactive === false ? true : await this.gateIo.confirm('trust host key?');
    if (!trusted) {
      throw new ProviderError('host key declined (no operator, interactive:false not signalled)');
    }
    return super.authenticate();
  }
}

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('prune — remote shard deletion through a host-key-gated provider', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-prune-hk-root-');
    pdirs = [await mkTmp('bfs-prune-hk-p0-'), await mkTmp('bfs-prune-hk-p1-'), await mkTmp('bfs-prune-hk-p2-')];
    providerRegistry.register(GATED_TYPE, {
      lang: 'en',
      displayName: 'Host-key gated (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new HostKeyGatedProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(GATED_TYPE);
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should delete the pruned shard from a host-key-gated medium, not orphan it', async () => {
    // Operator is present at init/push and confirms the host key, so every shard
    // uploads (this is the interactive path, distinct from the silent prune below).
    const presentIo = createMockProviderIO({ 'trust host key?': 'true' }).io;
    await fs.writeFile(path.join(root, 'data.txt'), 'backup payload', 'utf-8');

    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: [
        { id: 'p0', type: 'local', adapterPackage: null, config: { path: pdirs[0] ?? '' } },
        { id: 'p1', type: 'local', adapterPackage: null, config: { path: pdirs[1] ?? '' } },
        { id: 'p2', type: GATED_TYPE, adapterPackage: null, config: { path: pdirs[2] ?? '' } },
      ],
      push_mode: PushMode.NewVersion,
      io: presentIo,
    });
    await push(root, { io: presentIo }); // v1
    await push(root, { io: presentIo }); // v2 — leaves a surviving version after pruning v1

    const gatedShardV1 = path.join(pdirs[2] ?? '', 'vault', 'shard_2.bfs.1');
    const plainShardV1 = path.join(pdirs[0] ?? '', 'vault', 'shard_0.bfs.1');
    expect(existsSync(gatedShardV1)).toBe(true);
    expect(existsSync(plainShardV1)).toBe(true);

    // prune() constructs its own silent ProviderIO internally — no operator.
    await prune(root, { versions: [1] });

    // A/B control: the plain local shard is always removed (no host-key gate).
    expect(existsSync(plainShardV1)).toBe(false);

    // The bug: prune's silent IO drives the host-key gate into rejection and the
    // best-effort catch swallows the failed delete, orphaning the shard.
    expect(existsSync(gatedShardV1)).toBe(false);
  });
});
