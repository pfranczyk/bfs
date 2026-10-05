import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
// Importing the module also registers the `local` provider type.
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, RepairPair, VaultConfig, VerifyShardResult } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { repairVault } from '../../src/vault/repair.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

// A storage dropped with `provider remove --strategy remove` leaves the name it
// was recorded under in every manifest that used it, while the configuration
// stops knowing that name. Bringing it back means pointing a free configuration
// entry at it - and when that entry is a REPLACEMENT medium, nothing is there to
// relocate: the part has to be reconstructed from the remaining ones.
//
// The discriminator is which side of the pair the manifests know. A migration
// pair is `<configured name> -> <recorded name>`, so here the manifests know the
// DESTINATION id and have never heard of the source. Looking the rebuild up by
// the source id finds nothing to do, and a rebuild that finds nothing to do is
// indistinguishable from a rebuild that succeeded - the version stays degraded
// and the replacement stays empty while the command reports completion.
//
// Reconstruction cannot cost the destination check either. Once this form is the
// one `bfs verify` advises, it is the form operators reach for, so it has to keep
// refusing a destination that holds a part of ANOTHER backup - "no part there"
// and "somebody else's part there" are different answers, and only the first one
// means rebuild.

const VAULT = 'vault';
const BLIND_TYPE = 'cannot-verify-test';

/**
 * Local-disk storage that cannot answer what a file at a given path holds - the
 * shape of a medium whose adapter has no ranged read, where `unverifiable` is a
 * permanent property rather than damage. Everything else behaves as local disk.
 */
class BlindProvider extends LocalFsProvider {
  async verifyShard(): Promise<VerifyShardResult> {
    return { ok: false, reason: 'unverifiable', detail: 'this medium cannot verify a part in place' };
  }
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-migrate-rebuild-'));
}

function provider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function shardPath(dir: string, index: number, version: number): string {
  return path.join(dir, VAULT, `shard_${index}.bfs.${version}`);
}

async function readVaultConfig(root: string): Promise<VaultConfig> {
  const cfg = await readConfig(root);
  assert(cfg !== null, 'config must exist');
  return cfg;
}

/** Builds a vault of `dirs.length` local storages at the given scheme and pushes one version. */
async function buildVault(dirs: string[], dataShards: number, parityShards: number): Promise<{ root: string; io: ProviderIO }> {
  const root = await tmp();
  const io = createMockProviderIO({}, root, false).io;
  await init(root, {
    vault_name: VAULT,
    scheme: { data_shards: dataShards, parity_shards: parityShards },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.map((dir, i) => provider(`p${i}`, dir)),
    push_mode: PushMode.NewVersion,
    io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io });
  return { root, io };
}

/**
 * 2+1 vault on p0/p1/p2, one push, then the shape an operator reaches by
 * replacing a storage: p2 is dropped from the configuration (its name survives
 * in the v1 manifest) and a fresh p3 takes its slot, so the pool matches the
 * scheme again and p3 is used by no version.
 */
async function setupReplacedStorage(): Promise<{ root: string; dirs: string[]; replacement: string; lostDir: string; io: ProviderIO }> {
  const providerDirs = [await tmp(), await tmp(), await tmp()];
  const replacement = await tmp();
  const { root, io } = await buildVault(providerDirs, 2, 1);

  const cfg = await readVaultConfig(root);
  const survivors = cfg.providers.filter((p) => p.id !== 'p2');
  await writeConfig(root, { ...cfg, providers: [...survivors, provider('p3', replacement)] });

  const lostDir = providerDirs[2];
  assert(lostDir !== undefined, 'fixture must have a third storage');
  return { root, dirs: [root, ...providerDirs, replacement], replacement, lostDir, io };
}

/** The migration pair `bfs repair --version all p3 "local:p2 --path <dir>"` builds. */
function migrationPair(targetDir: string): RepairPair {
  return { oldName: 'p3', params: `local:p2 --path ${targetDir}`, rawParams: ['--path', targetDir], isMigration: true, newConfig: provider('p2', targetDir) };
}

function repairWithRebuild(root: string, pair: RepairPair, versions: number[], io: ProviderIO) {
  return repairVault(root, { pairs: [pair], versions, io, passwords: [], rebuild: true, forceUnverified: false });
}

describe('repair --rebuild onto the storage replacing one the configuration lost', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(BLIND_TYPE);
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs = [];
  });

  it('should reconstruct the recorded part onto an empty replacement', async () => {
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    expect(existsSync(shardPath(setup.replacement, 2, 1))).toBe(false);

    const result = await repairWithRebuild(setup.root, migrationPair(setup.replacement), [1], setup.io);

    expect(result.failed_pairs).toEqual([]);
    expect(existsSync(shardPath(setup.replacement, 2, 1))).toBe(true);
    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
    // The configuration has to carry the recorded name afterwards, otherwise the
    // next verify reports the same loss against a storage that now holds a part.
    const cfg = await readVaultConfig(setup.root);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p2']);
  });

  it('should leave the part untouched when the free entry already holds it', async () => {
    // The other shape this state comes in: the configuration entry was renamed
    // (an interrupted `bfs repair` writes the configuration before the
    // manifests), so the medium behind it still carries the recorded part.
    // Reconstruction has nothing to add there, and the part must come through
    // the repair as it was - mtime included, because identical bytes would not
    // tell a rewrite from an untouched file.
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    const shard = shardPath(setup.lostDir, 2, 1);
    const before = await fs.readFile(shard);
    const mtimeBefore = (await fs.stat(shard)).mtimeMs;

    const result = await repairWithRebuild(setup.root, migrationPair(setup.lostDir), [1], setup.io);

    expect(result.failed_pairs).toEqual([]);
    expect(await fs.readFile(shard)).toEqual(before);
    expect((await fs.stat(shard)).mtimeMs).toBe(mtimeBefore);
    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should refuse a replacement holding a part of another backup', async () => {
    // Same backup name, same part index, same version - and a different vault_id.
    // Reconstruction may only answer "nothing is there"; "somebody else's part is
    // there" stays a refusal, or the advised command becomes the one write path
    // with no identity check in front of it.
    const setup = await setupReplacedStorage();
    const foreignDirs = [await tmp(), await tmp(), await tmp()];
    const foreign = await buildVault(foreignDirs, 2, 1);
    dirs = [...setup.dirs, foreign.root, ...foreignDirs];
    const foreignDir = foreignDirs[2];
    assert(foreignDir !== undefined, 'the foreign fixture must have a third storage');
    const foreignShard = shardPath(foreignDir, 2, 1);
    await fs.mkdir(path.join(setup.replacement, VAULT), { recursive: true });
    await fs.copyFile(foreignShard, shardPath(setup.replacement, 2, 1));
    const planted = await fs.readFile(shardPath(setup.replacement, 2, 1));

    const result = await repairWithRebuild(setup.root, migrationPair(setup.replacement), [1], setup.io);

    expect(result.failed_pairs.map((p) => p.name)).toEqual(['p3']);
    expect(await fs.readFile(shardPath(setup.replacement, 2, 1))).toEqual(planted);
    expect(existsSync(path.join(setup.replacement, VAULT, 'hdr_2.bfs.1'))).toBe(false);
    const cfg = await readVaultConfig(setup.root);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p3']);
  });

  it('should fail loudly when too few parts remain to reconstruct', async () => {
    // The state where a silent success does the most damage: the operator is
    // told the replacement is filled precisely when the backup can no longer be
    // put back together.
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    const sibling = setup.dirs[1];
    assert(sibling !== undefined, 'fixture must have a first storage');
    await fs.rm(shardPath(sibling, 0, 1), { force: true });

    const result = await repairWithRebuild(setup.root, migrationPair(setup.replacement), [1], setup.io);

    expect(result.failed_pairs.map((p) => p.name)).toEqual(['p3']);
    expect(existsSync(shardPath(setup.replacement, 2, 1))).toBe(false);
    // A pair that failed leaves the pool the size it was: one entry too many and
    // the scheme stops matching, which refuses every write AND the retry of this
    // very command, the recorded name being taken by the half-finished repair.
    const cfg = await readVaultConfig(setup.root);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p3']);
  });

  it('should rebuild over a part the interrupted run left half-written', async () => {
    // The shape a power cut leaves behind: the header went out first and still
    // parses, so the identity check calls the part ours - while the payload is
    // short. Only its size tells the two apart, and `getSize` is the one question
    // every storage can answer, so this is what the retry has to lean on.
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    const sound = shardPath(setup.lostDir, 2, 1);
    const fullSize = (await fs.stat(sound)).size;
    await fs.mkdir(path.join(setup.replacement, VAULT), { recursive: true });
    const truncated = shardPath(setup.replacement, 2, 1);
    // Only the tail is missing: the header went out first and still parses, so
    // the identity check calls this part ours. Cutting deeper would damage the
    // header instead, which is a different state with a different answer.
    await fs.writeFile(truncated, (await fs.readFile(sound)).subarray(0, fullSize - 64));

    const result = await repairWithRebuild(setup.root, migrationPair(setup.replacement), [1], setup.io);

    expect(result.failed_pairs).toEqual([]);
    expect((await fs.stat(truncated)).size).toBe(fullSize);
    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should refuse a replacement whose content cannot be identified', async () => {
    // Nothing here says whose bytes these are - the header does not parse, so
    // the identity check has nothing to compare. Reconstruction writes over the
    // destination, so an unreadable file is a refusal, not a green light.
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    await fs.mkdir(path.join(setup.replacement, VAULT), { recursive: true });
    const junk = Buffer.alloc(512, 7);
    await fs.writeFile(shardPath(setup.replacement, 2, 1), junk);

    const result = await repairWithRebuild(setup.root, migrationPair(setup.replacement), [1], setup.io);

    expect(result.failed_pairs.map((p) => p.reason)).toEqual(['corrupted']);
    expect(await fs.readFile(shardPath(setup.replacement, 2, 1))).toEqual(junk);
    const cfg = await readVaultConfig(setup.root);
    expect(cfg.providers.map((p) => p.id).sort()).toEqual(['p0', 'p1', 'p3']);
  });

  it('should overwrite unidentifiable content once the operator waives the gate', async () => {
    // The way out of the refusal above, and the reason it is a refusal rather
    // than a dead end: the operator says in as many words that the destination
    // may be written over. Without this the advised command cannot recover from
    // an interruption that damaged the header it had just written.
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    const fullSize = (await fs.stat(shardPath(setup.lostDir, 2, 1))).size;
    await fs.mkdir(path.join(setup.replacement, VAULT), { recursive: true });
    await fs.writeFile(shardPath(setup.replacement, 2, 1), Buffer.alloc(512, 7));

    const result = await repairVault(setup.root, { pairs: [migrationPair(setup.replacement)], versions: [1], io: setup.io, passwords: [], rebuild: true, forceUnverified: true });

    expect(result.failed_pairs).toEqual([]);
    expect((await fs.stat(shardPath(setup.replacement, 2, 1))).size).toBe(fullSize);
    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should refuse a storage that cannot verify, and proceed once waived', async () => {
    // A medium with no ranged read can never say what lies at the destination.
    // Refusing keeps one contract with the migration that does not rebuild - and
    // the operator crosses that gate with the flag built for it, deliberately.
    providerRegistry.register(BLIND_TYPE, {
      lang: 'en',
      displayName: 'Storage that cannot verify (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new BlindProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
    const setup = await setupReplacedStorage();
    dirs = setup.dirs;
    const blindPair: RepairPair = {
      oldName: 'p3',
      params: `${BLIND_TYPE}:p2 --path ${setup.replacement}`,
      rawParams: ['--path', setup.replacement],
      isMigration: true,
      newConfig: { id: 'p2', type: BLIND_TYPE, adapterPackage: null, config: { path: setup.replacement } },
    };

    const refused = await repairWithRebuild(setup.root, blindPair, [1], setup.io);

    expect(refused.failed_pairs.map((p) => p.reason)).toEqual(['unverifiable']);
    expect(existsSync(shardPath(setup.replacement, 2, 1))).toBe(false);

    // A refused run keeps its lock for the operator to read. The next CLI run is
    // a new process, so it finds a dead owner and clears it; inside one test
    // process the owner is still alive, which is a property of the harness.
    await fs.rm(path.join(setup.root, '.bfs', 'repair.lock'), { force: true });

    const waived = await repairVault(setup.root, { pairs: [blindPair], versions: [1], io: setup.io, passwords: [], rebuild: true, forceUnverified: true });

    expect(waived.failed_pairs).toEqual([]);
    expect(existsSync(shardPath(setup.replacement, 2, 1))).toBe(true);
  });

  it('should rebuild only the versions that recorded the storage', async () => {
    // `--version all` is the form the advice names, and a pool that spent time
    // one storage short has versions that never heard of the lost name. Those
    // must come through untouched, without turning the run into a failure.
    const providerDirs = [await tmp(), await tmp(), await tmp(), await tmp()];
    const replacement = await tmp();
    const { root, io } = await buildVault(providerDirs, 3, 1);
    dirs = [root, ...providerDirs, replacement];

    // The storage is lost and the scheme matched to the survivors, then a second
    // version goes out on the smaller pool - it records p0, p1, p2 and nothing else.
    const afterLoss = await readVaultConfig(root);
    await writeConfig(root, { ...afterLoss, providers: afterLoss.providers.filter((p) => p.id !== 'p3'), scheme: { data_shards: 2, parity_shards: 1 } });
    await fs.writeFile(path.join(root, 'c.txt'), 'ccc', 'utf-8');
    await push(root, { io });

    // The replacement arrives and the original scheme comes back.
    const beforeAdd = await readVaultConfig(root);
    await writeConfig(root, { ...beforeAdd, providers: [...beforeAdd.providers, provider('p4', replacement)], scheme: { data_shards: 3, parity_shards: 1 } });

    const pair: RepairPair = { oldName: 'p4', params: `local:p3 --path ${replacement}`, rawParams: ['--path', replacement], isMigration: true, newConfig: provider('p3', replacement) };
    const result = await repairVault(root, { pairs: [pair], versions: [1, 2], io, passwords: [], rebuild: true, forceUnverified: false });

    expect(result.failed_pairs).toEqual([]);
    expect(existsSync(shardPath(replacement, 3, 1))).toBe(true);
    expect(existsSync(shardPath(replacement, 3, 2))).toBe(false);
    expect((await verifyVersion(root, 1, io)).health).toBe(VersionHealth.Healthy);
    expect((await verifyVersion(root, 2, io)).health).toBe(VersionHealth.Healthy);
  });
});
