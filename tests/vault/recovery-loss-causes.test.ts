import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { recover } from '../../src/vault/recovery.js';
import { init, push } from '../../src/vault/vault-manager.js';

// --- What this pins ----------------------------------------------------------
//
// `recover()` settles each version's health through `verifyAll`, so a "degraded"
// verdict is computed FROM the knowledge of which medium is short of its part.
// The report it hands back must carry that knowledge on, as data: the command
// layer is the only place allowed to phrase it for the operator, and a report
// that stops at the verdict leaves nothing for it to phrase.
//
// The same contract read from the operator's end: the report a recovery prints
// names the lost medium beside the version's status, not the status alone.
//
// The assertion is on the medium reaching the CALLER rather than on any printed
// sentence, because that is what survives a change of output channel.

const VAULT_NAME = 'loss-causes';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

function localConfig(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/**
 * Stands up a `--no-enc` 2/1 vault on three local media, pushes v1, then wipes
 * .bfs/ AND destroys the medium holding shard_2 - the disaster in which one
 * version survives (2 of 3 parts) but one medium is gone for good.
 */
async function setupAndLoseOneMedium(root: string, dirs: string[]): Promise<void> {
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
  await init(root, {
    vault_name: VAULT_NAME,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.map((d, i) => localConfig(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: mockIO(),
  });
  await push(root, { io: mockIO() });
  await fs.rm(path.join(root, '.bfs'), { recursive: true });
  await fs.rm(dirs[2] ?? '', { recursive: true, force: true });
}

describe('recover() hands the caller the causes behind a degraded version', () => {
  let root = '';
  let dirs: string[] = [];

  beforeEach(async () => {
    root = await tmp('bfs-loss-root-');
    dirs = [await tmp('bfs-loss-p0-'), await tmp('bfs-loss-p1-'), await tmp('bfs-loss-p2-')];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should report the lost medium by name, not just the health verdict', async () => {
    await setupAndLoseOneMedium(root, dirs);

    const { io } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(localConfig('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io });

    const v1 = report.versions.find((v) => v.version === 1);
    expect(v1).toBeDefined();
    // Two of three parts survive, so the verdict has to settle on degraded -
    // healthy or damaged here would mean the check never saw the loss this test
    // is about, and every assertion below would be measuring the wrong run.
    expect(v1?.health).toBe(VersionHealth.Degraded);

    const causes = v1?.loss_causes ?? [];
    expect(causes.length).toBeGreaterThan(0);
    const named = causes.flatMap((c) => c.providers);
    expect(named).toContain('p2');
    // The two surviving media must not be blamed - a report that listed every
    // configured medium would pass a "contains p2" check while telling the
    // operator nothing.
    expect(named).not.toContain('p0');
    expect(named).not.toContain('p1');
  });
});
