import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, VaultAlreadyInitializedError } from '../../src/core/errors.js';
import { setLang } from '../../src/i18n/index.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { recover } from '../../src/vault/recovery.js';
import { init, push } from '../../src/vault/vault-manager.js';

// --- What this pins ----------------------------------------------------------
//
// `recover()` rebuilds .bfs/ for a directory that lost it, and ends by writing
// .bfs/config.json. In a directory whose config.json still describes a backup
// that write replaces the provider settings and the link to every version, and
// leaves the old manifests behind as orphans - whoever's backup the recovery was
// asked for. So recovery refuses whenever the file holds a readable
// configuration, and refuses BEFORE anything else: its first step empties
// .bfs/cache, where `bfs push --cache` resumes an interrupted push from.
//
// A file that exists but cannot be read at all says nothing about whether a
// backup is here, and overwriting it during a momentary lock would destroy a live
// one - so that refuses too, naming the read error. A file that reads but does
// not describe a backup (empty, unparsable, no backup name) is what an
// interrupted or damaged run leaves behind, and recovery starting over is what
// keeps a failed recovery retryable.

const VAULT_NAME = 'refuse-live-config';

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

function localConfig(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** Stands up a `--no-enc` 2/1 vault on three local media and pushes v1; .bfs/ stays in place. */
async function setupLiveVault(root: string, dirs: string[]): Promise<void> {
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
}

/** The files a refused recovery must leave byte-for-byte as they were. */
const KEPT = [path.join('.bfs', 'config.json'), path.join('.bfs', 'state.json'), path.join('.bfs', 'manifests', 'v001.json'), path.join('.bfs', 'cache', 'sentinel')];

async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const rel of KEPT) out.set(rel, await fs.readFile(path.join(root, rel)));
  return out;
}

describe('recover() in a directory that already holds a backup', () => {
  let root = '';
  let dirs: string[] = [];
  let bootstrap: LocalFsProvider;

  beforeEach(async () => {
    root = await tmp('bfs-refuse-root-');
    dirs = [await tmp('bfs-refuse-p0-'), await tmp('bfs-refuse-p1-'), await tmp('bfs-refuse-p2-')];
    await setupLiveVault(root, dirs);
    // Stands for an interrupted push waiting to resume from the cache.
    await fs.mkdir(path.join(root, '.bfs', 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.bfs', 'cache', 'sentinel'), 'pending', 'utf-8');
    bootstrap = new LocalFsProvider(localConfig('p0', dirs[0] ?? ''), mockIO());
    await bootstrap.authenticate();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setLang('en');
    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should refuse to replace the configuration of the backup it was asked to recover', async () => {
    const before = await snapshot(root);
    const list = vi.spyOn(bootstrap, 'list');

    const run = recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() });

    await expect(run).rejects.toThrow(VaultAlreadyInitializedError);
    await expect(run).rejects.toThrow(`already holds a backup named "${VAULT_NAME}"`);
    await expect(run).rejects.toThrow('bfs pull');
    await expect(run).rejects.toThrow('delete the .bfs directory here');
    await expect(run).rejects.toThrow('in another directory');
    expect(list, 'the refusal must come before the media are touched').not.toHaveBeenCalled();
    expect(await snapshot(root), 'a refused recovery must leave config, state, manifests and cache exactly as they were').toEqual(before);
  });

  it('should refuse to replace the configuration of a different backup, naming the one that is here', async () => {
    const configPath = path.join(root, '.bfs', 'config.json');
    const other = JSON.parse(await fs.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    await fs.writeFile(configPath, JSON.stringify({ ...other, vault_name: 'someone-else', vault_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' }, null, 2), 'utf-8');
    const before = await snapshot(root);

    const run = recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() });

    await expect(run).rejects.toThrow(VaultAlreadyInitializedError);
    await expect(run).rejects.toThrow('already holds a backup named "someone-else"');
    // An operator after a DIFFERENT backup is served by neither of the other two
    // ways: `bfs pull` restores the one that is here, and deleting .bfs/ takes
    // its configuration with it. The third way costs nothing here.
    await expect(run).rejects.toThrow('in another directory');
    expect(await snapshot(root), 'the backup that lives here must survive a recovery of another one').toEqual(before);
  });

  // A directory in place of the file is the portable way to make the read itself
  // fail. What matters is that the run does not read the failure as "no backup".
  it('should refuse, naming the read error, when config.json cannot be read at all', async () => {
    const configPath = path.join(root, '.bfs', 'config.json');
    await fs.rm(configPath);
    await fs.mkdir(configPath);

    const run = recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() });

    await expect(run).rejects.toThrow(BfsError);
    await expect(run).rejects.toThrow('EISDIR');
    // The way out that works whatever the read error turns out to be.
    await expect(run).rejects.toThrow('run `bfs recovery` in another directory');
    expect(await fs.readFile(path.join(root, '.bfs', 'cache', 'sentinel'), 'utf-8'), 'an undecided read must not let recovery empty the cache').toBe('pending');
    expect((await fs.stat(configPath)).isDirectory(), 'the unreadable entry must be left for the operator to settle').toBe(true);
  });

  it('should give the Polish operator the same way out of an undecided read', async () => {
    const configPath = path.join(root, '.bfs', 'config.json');
    await fs.rm(configPath);
    await fs.mkdir(configPath);
    setLang('pl');

    const err = await recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() }).then(
      () => null,
      (e: unknown) => String(e),
    );

    setLang('en');
    expect(err).toContain('uruchom `bfs recovery` w innym katalogu');
  });

  // --- Positive controls: what is left there is not a configuration ------------
  // Each of these is a state an interrupted or damaged run leaves behind. Refusing
  // on them would make a failed recovery impossible to repeat.

  it('should start over on a .bfs/ that holds no config.json', async () => {
    await fs.rm(path.join(root, '.bfs', 'config.json'));

    await recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() });

    expect((await readConfig(root))?.vault_name).toBe(VAULT_NAME);
  });

  it.each([
    ['empty', ''],
    ['unparsable', '{"vault_na'],
    ['a JSON null', 'null'],
    ['JSON without a backup name', '{}'],
  ])('should start over when config.json is %s', async (_label, content) => {
    await fs.writeFile(path.join(root, '.bfs', 'config.json'), content, 'utf-8');

    await recover(root, { vaultName: VAULT_NAME, provider: bootstrap, io: mockIO() });

    expect((await readConfig(root))?.vault_name).toBe(VAULT_NAME);
  });
});
