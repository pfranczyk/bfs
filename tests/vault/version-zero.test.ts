import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { listUnrecoveredVersions, readManifest, writeUnrecoveredMarker } from '../../src/vault/manifest.js';
import { readState } from '../../src/vault/state.js';
import { init, prune, pull, push } from '../../src/vault/vault-manager.js';

// Version 0 means "no backup yet": it is what state.json holds after init, and a
// plain pull starts from it. So no push may write a backup as version 0, and a
// backup already written that way - released versions did, under
// push_mode=ask, when the operator took "Overwrite (v0)" with no current version
// on disk - is restored by looking for its manifest instead of being reported as
// missing.

const VAULT_NAME = 'version-zero';
const FIXTURE = fileURLToPath(new URL('../fixtures/v0-backup-0.14.4', import.meta.url));

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** An io that takes "Overwrite" whenever push asks, and records each question. */
function overwritingIo(root: string): { io: ProviderIO; asked: string[] } {
  const asked: string[] = [];
  const { io } = createMockProviderIO({}, root, true);
  return {
    asked,
    io: {
      ...io,
      async choose(message: string, options: string[]): Promise<string> {
        asked.push(message);
        return options.find((o) => o.startsWith('Overwrite')) ?? options[0] ?? '';
      },
    },
  };
}

describe('push under push_mode=ask never writes version 0', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-v0-push-root-');
    pdirs = [await mkTmp('bfs-v0-push-p0-'), await mkTmp('bfs-v0-push-p1-'), await mkTmp('bfs-v0-push-p2-')];
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.Ask,
      io: createMockProviderIO({}, root, false).io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should create version 1 on the first push without asking to overwrite', async () => {
    const { io, asked } = overwritingIo(root);

    const result = await push(root, { io });

    expect(result.version).toBe(1);
    expect(asked).toEqual([]);
    expect((await readState(root)).latest_version).toBe(1);
    await expect(fs.access(path.join(pdirs[0], VAULT_NAME, 'shard_0.bfs.0'))).rejects.toThrow();
  });

  // No current version on disk while older versions exist: prune of the newest
  // version, like recovery, leaves working_version at 0 with latest_version above
  // it. Overwriting "v0" there would hide the newest data behind the older ones.
  it('should create a new version when no version is on disk but older ones exist', async () => {
    const quiet = overwritingIo(root).io;
    await push(root, { io: quiet, mode: PushMode.NewVersion });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa-v2', 'utf-8');
    await push(root, { io: quiet, mode: PushMode.NewVersion });
    await prune(root, { versions: [2], io: quiet });
    expect(await readState(root)).toMatchObject({ latest_version: 1, working_version: 0 });
    const { io, asked } = overwritingIo(root);

    const result = await push(root, { io });

    expect(result.version).toBe(2);
    expect(asked).toEqual([]);
    await expect(fs.access(path.join(pdirs[0], VAULT_NAME, 'shard_0.bfs.0'))).rejects.toThrow();
  });

  it('should still offer to overwrite once a version is on disk', async () => {
    await push(root, { io: overwritingIo(root).io, mode: PushMode.NewVersion });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa-updated', 'utf-8');
    const { io, asked } = overwritingIo(root);

    const result = await push(root, { io });

    expect(asked).toHaveLength(1);
    expect(result.version).toBe(1);
  });
});

describe('pull of a backup written as version 0', () => {
  let work: string;
  let root: string;

  beforeEach(async () => {
    work = await mkTmp('bfs-v0-pull-');
    await fs.cp(FIXTURE, work, { recursive: true });
    root = path.join(work, 'vault');
    // Storage p<i> keeps its part in media/m<i>; only the absolute paths move.
    const cfgPath = path.join(root, '.bfs', 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8')) as VaultConfig;
    cfg.providers.forEach((p, i) => {
      p.config.path = path.join(work, 'media', `m${i}`);
    });
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  });

  afterEach(async () => {
    await fs.rm(work, { recursive: true, force: true });
  });

  it('should restore it with a plain pull', async () => {
    const expected = await fs.readFile(path.join(root, 'notes.txt'));
    await fs.rm(path.join(root, 'notes.txt'));

    const result = await pull(root, { io: createMockProviderIO({}, root, false).io, force: true, yes: true });

    expect(result.version).toBe(0);
    expect(await fs.readFile(path.join(root, 'notes.txt'))).toEqual(expected);
  });

  it('should restore it with pull --version 0', async () => {
    const expected = await fs.readFile(path.join(root, 'notes.txt'));
    await fs.rm(path.join(root, 'notes.txt'));

    const result = await pull(root, { version: 0, io: createMockProviderIO({}, root, false).io, force: true, yes: true });

    expect(result.version).toBe(0);
    expect(await fs.readFile(path.join(root, 'notes.txt'))).toEqual(expected);
  });

  // Recovery that cannot open an encrypted version with the passwords it was
  // given records it as present but not recovered - an empty manifest file - and
  // pull rebuilds it from the parts. The marker is planted by hand on this
  // unencrypted backup: the version 0 check runs before any decryption.
  it.each([
    ['pull --version 0', { version: 0 }],
    ['a plain pull', {}],
  ])('should rebuild and restore it with %s when only the not-recovered marker is left', async (_label, select) => {
    const expected = await fs.readFile(path.join(root, 'notes.txt'));
    await fs.rm(path.join(root, 'notes.txt'));
    await writeUnrecoveredMarker(root, 0);
    expect(await listUnrecoveredVersions(root)).toEqual([0]);

    const result = await pull(root, { ...select, io: createMockProviderIO({}, root, false).io, force: true, yes: true });

    expect(result.version).toBe(0);
    expect(await fs.readFile(path.join(root, 'notes.txt'))).toEqual(expected);
    expect(await listUnrecoveredVersions(root)).toEqual([]);
    expect((await readManifest(root, 0))?.shards.map((s) => s.provider_id).sort()).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('pull with nothing pushed yet', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-v0-fresh-root-');
    pdirs = [await mkTmp('bfs-v0-fresh-p0-'), await mkTmp('bfs-v0-fresh-p1-'), await mkTmp('bfs-v0-fresh-p2-')];
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: createMockProviderIO({}, root, false).io,
    });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should report that there is no backup to restore', async () => {
    const attempt = pull(root, { io: createMockProviderIO({}, root, false).io, force: true, yes: true });

    await expect(attempt).rejects.toThrow(BfsError);
    await expect(attempt).rejects.toThrow(/No versions available/);
  });
});
