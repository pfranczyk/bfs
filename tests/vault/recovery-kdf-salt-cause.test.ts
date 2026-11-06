import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, describe, expect, it } from 'vitest';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
// Importing the module also registers the `local` provider type.
import '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ShardHeader } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { rebuildVersionManifest } from '../../src/vault/version-rebuild.js';

// A version's Argon2id salt is shared by all of its parts. When ONE part's salt
// rots, recovery survives it - the map comes from a sibling, or the damaged part
// is never the one the map is read from. "A medium could not supply the map"
// alone would read the same for a wrong password, and a damaged part standing
// BEHIND the one the map came from would never be looked at; so every collected
// header of the version is weighed, and a part whose salt the others do not
// share gets a line of its own.
//
// The line reports what was seen, as it is: that part's header carries a salt
// the other parts do not, under the name the configuration gives that storage.
// BFS does not know why - rot on the medium and an interrupted overwrite leave
// the same header - so the line guesses no cause and offers no repair, only the
// command to check the backup with. Nothing about the run changes: no version is
// dropped, nothing aborts.
//
// The line is kept to parts of THIS backup carrying the same content hash as the
// part the map came from, and the yardstick is the salt most of them share. A
// part of another push under the same version number (interrupted
// `push --overwrite`) or of another backup already has its own, accurate
// sentence - "backup data that does not match this version's record" - and a
// second line about its salt would only repeat it.

const VAULT = 'vault';
const PASSWORD = 'salt-cause-secret';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-salt-cause-'));
}

function provider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function shardPath(dir: string, index: number, version: number): string {
  return path.join(dir, VAULT, `shard_${index}.bfs.${version}`);
}

function storageAt(storages: string[], slot: number): string {
  const dir = storages[slot];
  assert(dir !== undefined, `fixture has no storage ${slot}`);
  return dir;
}

/** Parses the header of one part on disk. */
async function headerOf(file: string): Promise<ShardHeader> {
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(await fs.readFile(file)));
  payloadStream.on('error', () => {}).destroy();
  return header;
}

/** Reads the KDF salt from the header of one part on disk. */
async function saltOf(file: string): Promise<Buffer> {
  const header = await headerOf(file);
  assert(header.kdf_salt !== null, `${file} must be an encrypted part carrying a salt`);
  return header.kdf_salt;
}

/**
 * Flips one byte of the KDF salt in a part's header, in place, WITHOUT
 * recomputing the part's trailing checksum - the shape bit-rot leaves behind.
 */
async function damageSalt(file: string): Promise<void> {
  const bytes = await fs.readFile(file);
  const at = bytes.indexOf(await saltOf(file));
  assert(at >= 0, 'the salt must be found in the part header');
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  await fs.writeFile(file, bytes);
}

/**
 * Encrypted 2+1 backup on p0/p1/p2 with two pushed versions, `.bfs/` still
 * present. `betweenPushes` runs after v1 and before v2 - the only point where v1
 * is still the latest version, so an overwrite there rewrites v1.
 */
async function buildBackup(betweenPushes?: (root: string, storages: string[]) => Promise<void>, v2Password: string = PASSWORD): Promise<{ root: string; storages: string[]; vaultId: string }> {
  const storages = [await tmp(), await tmp(), await tmp()];
  const root = await tmp();
  const { io } = createMockProviderIO({}, root, false);
  await init(root, {
    vault_name: VAULT,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: storages.map((dir, i) => provider(`p${i}`, dir)),
    push_mode: PushMode.NewVersion,
    io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'v1', 'utf-8');
  await push(root, { io, password: PASSWORD });
  if (betweenPushes) await betweenPushes(root, storages);
  await fs.writeFile(path.join(root, 'a.txt'), 'v2', 'utf-8');
  await push(root, { io, password: v2Password });
  const config = await readConfig(root);
  assert(config !== null, 'config must exist after init');
  return { root, storages, vaultId: config.vault_id };
}

/**
 * Between-pushes hook: an interrupted overwrite of v1 that leaves p2 holding the
 * part of the earlier push - its own packed backup, its own salt - as a medium
 * refusing the overwrite would leave it.
 */
async function interruptedOverwriteOfV1(root: string, storages: string[]): Promise<void> {
  const earlier = await fs.readFile(shardPath(storageAt(storages, 2), 2, 1));
  const { io } = createMockProviderIO({}, root, false);
  await fs.writeFile(path.join(root, 'a.txt'), 'v1 overwritten', 'utf-8');
  await push(root, { io, password: PASSWORD, mode: PushMode.Overwrite });
  await fs.writeFile(shardPath(storageAt(storages, 2), 2, 1), earlier);
}

/**
 * Between-pushes hook: a resumed overwrite of v1 that leaves p2 holding the part
 * of the first attempt - same packed backup, its own salt. Attempt 1 is refused
 * by p1 (a directory where its part belongs), attempt 2 resumes from the cache
 * and p2's part is put back to attempt 1's, as a medium refusing attempt 2
 * would leave it.
 */
async function resumedOverwriteOfV1(root: string, storages: string[]): Promise<void> {
  const { io } = createMockProviderIO({}, root, false);
  await fs.writeFile(path.join(root, 'a.txt'), 'v1 overwritten', 'utf-8');
  const p1Part = shardPath(storageAt(storages, 1), 1, 1);
  await fs.rm(p1Part, { force: true });
  await fs.mkdir(p1Part);
  await push(root, { io, password: PASSWORD, mode: PushMode.Overwrite }).catch(() => {});
  await fs.rm(p1Part, { recursive: true, force: true });
  const attempt1 = await fs.readFile(shardPath(storageAt(storages, 2), 2, 1));
  await push(root, { io, password: PASSWORD, mode: PushMode.Overwrite, fromCache: true });
  await fs.writeFile(shardPath(storageAt(storages, 2), 2, 1), attempt1);
}

async function loseMetadata(root: string): Promise<void> {
  await fs.rm(path.join(root, '.bfs'), { recursive: true, force: true });
}

/** Runs recovery from storage `slot`, under the id the CLI gives a bootstrap medium. */
async function recoverFrom(root: string, storages: string[], slot: number, passwords: string[] = [PASSWORD]) {
  const { io, logs } = createMockProviderIO({}, root, false);
  const bootstrap = providerRegistry.create(provider('bootstrap-local', storageAt(storages, slot)), io);
  await bootstrap.authenticate();
  const report = await recover(root, { vaultName: VAULT, provider: bootstrap, io, passwords });
  return { report, warnings: logs.filter((l) => l.level === 'warn').map((l) => l.message) };
}

/** The sentence recovery must print for a part whose salt differs. */
function saltCause(version: number, storage: string): string {
  return fmt('recovery_kdf_salt_mismatch', String(version), storage);
}

/** Every salt line among the warnings, whichever part and version it names. */
function saltLines(warnings: string[]): string[] {
  const marker = fmt('recovery_kdf_salt_mismatch', '\u0000', '\u0000').split('\u0000')[2] ?? '';
  // An empty marker would let every "no line" control pass whatever is printed.
  assert(marker !== '', 'the salt marker must be a real fragment of the sentence');
  return warnings.filter((w) => w.includes(marker));
}

describe('recover() naming a part whose KDF salt differs from its siblings', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs = [];
  });

  it('should name the configured storage, not the bootstrap id, when the damaged part is the one read first', async () => {
    const { root, storages } = await buildBackup();
    dirs = [root, ...storages];
    await damageSalt(shardPath(storageAt(storages, 0), 0, 1));
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'the damaged version must still be rebuilt - the run does not change').toEqual([1, 2]);
    expect(report.versions.find((v) => v.version === 1)?.consensus, 'consensus is withheld exactly as before - the map came from a sibling').toBe(false);
    expect(saltLines(warnings), 'exactly one line, naming p0 - the name the configuration gives it - not the bootstrap id').toEqual([saltCause(1, 'p0')]);
  });

  it('should name a damaged part standing behind the part the map came from', async () => {
    // A/B against the case above: here the first part opens the map, so nothing
    // "could not supply" it and no sentence names p2 unless the remaining parts
    // are inspected too.
    const { root, storages } = await buildBackup();
    dirs = [root, ...storages];
    await damageSalt(shardPath(storageAt(storages, 2), 2, 1));
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    expect(report.versions.find((v) => v.version === 1)?.consensus, 'consensus is judged as before - the map opened on the first part').toBe(true);
    expect(saltLines(warnings), 'exactly one line, naming p2').toEqual([saltCause(1, 'p2')]);
  });

  it('should name a part of the bootstrap version whose salt differs, exactly once', async () => {
    // The bootstrap version is read twice - cross-checked before any secret is
    // sent, then rebuilt like every other version. The cause is one fact and is
    // reported once.
    const { root, storages } = await buildBackup();
    dirs = [root, ...storages];
    await damageSalt(shardPath(storageAt(storages, 1), 1, 2));
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt - the salt does not join consensus').toEqual([1, 2]);
    expect(saltLines(warnings), 'exactly one line, naming p1 on v2').toEqual([saltCause(2, 'p1')]);
  });

  it('should not name a whole part of another push left behind by an interrupted overwrite', async () => {
    // An interrupted `push --overwrite` leaves parts of two pushes under one
    // version number. The earlier part carries the earlier push's salt and its
    // content hash - it is reported as data not matching the version's record,
    // not a second time through its salt.
    const { root, storages } = await buildBackup(interruptedOverwriteOfV1);
    dirs = [root, ...storages];
    await loseMetadata(root);
    // Guards the fixture: without a differing salt on p2 this control passes
    // whatever the rule is.
    expect((await saltOf(shardPath(storageAt(storages, 2), 2, 1))).equals(await saltOf(shardPath(storageAt(storages, 0), 0, 1))), 'the earlier part must carry a salt of its own').toBe(false);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    expect(saltLines(warnings), "a part carrying another push's content hash gets no salt line").toEqual([]);
  });

  it('should not name the parts of the later push when the map came from the earlier one', async () => {
    // A/B against the case above: recovery bootstraps from p2, so the map comes
    // from the lone part of the earlier push. The salts are weighed only among
    // parts carrying the map source's content hash - here that is the source
    // alone - so neither it nor the two parts of the later push are named.
    const { root, storages } = await buildBackup(interruptedOverwriteOfV1);
    dirs = [root, ...storages];
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 2);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    // Guards the A/B: the rebuilt record follows the part the map came from,
    // which must be p2's here - otherwise this case repeats the one above.
    expect((await readManifest(root, 1))?.blob_hash, 'the map must have come from the earlier push on p2').toBe((await headerOf(shardPath(storageAt(storages, 2), 2, 1))).blob_hash);
    expect(saltLines(warnings), 'parts of two pushes are not weighed against each other by salt').toEqual([]);
  });

  it('should name no part when the reachable parts split evenly between two salts', async () => {
    // Two reachable parts of a 2+1 version (the third is gone) carrying two
    // different salts: no salt is shared by more parts than the other, so the
    // line has no "other parts" to compare against and names neither. The
    // damaged part is still named by `bfs pull` and `bfs verify --deep`, which
    // read its checksum.
    const { root, storages } = await buildBackup();
    dirs = [root, ...storages];
    await fs.rm(shardPath(storageAt(storages, 1), 1, 1));
    await damageSalt(shardPath(storageAt(storages, 2), 2, 1));
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'the version is still rebuilt from the map on p0').toEqual([1, 2]);
    expect(saltLines(warnings), 'an even split names no part').toEqual([]);
  });

  it('should not name a part left by an interrupted overwrite under a changed password', async () => {
    // The state measured on the real CLI: v1 under password A, then
    // `push --overwrite` under password B that one medium refused, so its v1
    // part stays the earlier, healthy one; the operator clears the lock and keeps
    // pushing under B, and later recovers with B alone. That part's map opens
    // under its own salt only with A, which nobody supplied. Its content hash
    // still tells it apart: a part of another push carries that push's
    // blob_hash, which keeps it out of the salt line.
    const NEW_PASSWORD = 'salt-cause-rotated';
    const { root, storages } = await buildBackup(async (r, s) => {
      const earlier = await fs.readFile(shardPath(storageAt(s, 2), 2, 1));
      const { io } = createMockProviderIO({}, r, false);
      await fs.writeFile(path.join(r, 'a.txt'), 'v1 overwritten', 'utf-8');
      await push(r, { io, password: NEW_PASSWORD, mode: PushMode.Overwrite });
      await fs.writeFile(shardPath(storageAt(s, 2), 2, 1), earlier);
    }, NEW_PASSWORD);
    dirs = [root, ...storages];
    await loseMetadata(root);
    expect((await saltOf(shardPath(storageAt(storages, 2), 2, 1))).equals(await saltOf(shardPath(storageAt(storages, 0), 0, 1))), 'the earlier part must carry a salt of its own').toBe(false);

    const { report, warnings } = await recoverFrom(root, storages, 0, [NEW_PASSWORD]);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    expect(saltLines(warnings), 'a whole part of another push gets no salt line, even when its password was not supplied').toEqual([]);
  });

  it('should name a part left by an earlier attempt of a resumed overwrite', async () => {
    // Measured on the real CLI: `push --overwrite` refused by one medium leaves
    // the packed backup in the cache; `push --cache --overwrite` sends the SAME
    // backup again under a fresh salt, and a medium that refuses that second
    // attempt keeps the part of the first one. That part has the version's
    // blob_hash and a salt of its own - from the header alone it looks the same
    // as rot, so the same observation is reported.
    const { root, storages } = await buildBackup(resumedOverwriteOfV1);
    dirs = [root, ...storages];
    await loseMetadata(root);
    // Guards the fixture: same content hash, different salt.
    const [h0, h2] = [await headerOf(shardPath(storageAt(storages, 0), 0, 1)), await headerOf(shardPath(storageAt(storages, 2), 2, 1))];
    expect(h2.blob_hash, 'the earlier attempt carries the same packed backup').toBe(h0.blob_hash);
    expect(h2.kdf_salt?.equals(h0.kdf_salt ?? Buffer.alloc(0)), 'the earlier attempt carries a salt of its own').toBe(false);

    const { report, warnings } = await recoverFrom(root, storages, 0);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    expect(saltLines(warnings), 'exactly one line, naming p2 - what is seen is reported, whatever caused it').toEqual([saltCause(1, 'p2')]);
  });

  it('should name the outlying part even when the map came from it', async () => {
    // A/B against the case above: recovery bootstraps from p2, so the part
    // holding the earlier attempt opens the map first. "Differs from the other
    // parts" has to stay true here too - the line names the one part whose
    // salt the others do not share, never the agreeing majority.
    const { root, storages } = await buildBackup(resumedOverwriteOfV1);
    dirs = [root, ...storages];
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 2);

    expect(report.versions.map((v) => v.version).sort(), 'every version must still be rebuilt').toEqual([1, 2]);
    expect(saltLines(warnings), 'exactly one line, naming p2 - not p0 and p1, which agree with each other').toEqual([saltCause(1, 'p2')]);
  });

  it('should name no part of a version whose map no supplied password opens', async () => {
    // Without a map nothing is compared: a version left unopened says so through
    // its own sentence, and no salt line may be guessed for it.
    const OTHER_PASSWORD = 'salt-cause-other';
    const { root, storages } = await buildBackup(undefined, OTHER_PASSWORD);
    dirs = [root, ...storages];
    await damageSalt(shardPath(storageAt(storages, 0), 0, 1));
    await loseMetadata(root);

    const { report, warnings } = await recoverFrom(root, storages, 0, [OTHER_PASSWORD]);

    expect(
      report.versions.map((v) => v.version),
      'only v2 opens with the supplied password',
    ).toEqual([2]);
    expect(saltLines(warnings), 'an unopened version gets no salt line').toEqual([]);
  });

  it('should not name a part of another backup sitting under our name', async () => {
    // Same backup name, same password, different backup: its part belongs to
    // someone else - another vault id and, since the packed backup records that
    // id, another content hash - not a header of ours.
    const { root, storages } = await buildBackup();
    const other = await buildBackup();
    dirs = [root, ...storages, other.root, ...other.storages];
    await fs.copyFile(shardPath(storageAt(other.storages, 2), 2, 1), shardPath(storageAt(storages, 2), 2, 1));
    await loseMetadata(root);

    const { warnings } = await recoverFrom(root, storages, 0);

    expect(saltLines(warnings), 'a part of another backup gets no salt line').toEqual([]);
  });

  it('should name no salt cause when every part is intact', async () => {
    const { root, storages } = await buildBackup();
    dirs = [root, ...storages];
    await loseMetadata(root);

    const { warnings } = await recoverFrom(root, storages, 0);

    expect(saltLines(warnings), 'an intact backup must not report any salt mismatch').toEqual([]);
  });

  it('should name the damaged part when `bfs pull` rebuilds a version from the media', async () => {
    // `bfs pull` rebuilds a version recovery left unopened through the same
    // function; the cause and the advice are the same there, so the line is too.
    const { root, storages, vaultId } = await buildBackup();
    dirs = [root, ...storages];
    await damageSalt(shardPath(storageAt(storages, 0), 0, 1));
    const { io, logs } = createMockProviderIO({}, root, false);
    const entries = storages.map((dir, i) => {
      const p = providerRegistry.create(provider(`p${i}`, dir), io);
      return { shardIndex: i, provider: p };
    });
    for (const e of entries) await e.provider.authenticate();

    const result = await rebuildVersionManifest(1, entries, { vaultName: VAULT, vaultId, passwordPool: [PASSWORD], caller: 'pull', io });

    expect(result.outcome, 'the version must still be rebuilt from a sibling').toBe('recovered');
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(saltLines(warnings), 'exactly one line, naming p0').toEqual([saltCause(1, 'p0')]);
  });
});
