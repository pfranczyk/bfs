import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { packBlob } from '../../src/core/blob-pack.js';
import { hashBuffer, SHA256_BYTES } from '../../src/core/hash.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import { rsEncode } from '../../src/core/reed-solomon.js';
import { buildHeaderBytes, buildShard, computeShardHeaderSize, parseShardHeaderFromStream, uuidToBuffer } from '../../src/core/shard-io.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, ShardHeader, ShardLocation, VaultConfig, VersionManifest } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { writeManifest } from '../../src/vault/manifest.js';
import { writeState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// A part is addressed by its file name alone - shard_{i}.bfs.{V} - so what sits
// under that name is not necessarily the part the restore asked for. A whole,
// checksum-clean part of another version, of another backup, or of a backup cut
// a different way passes the name test; both read paths therefore ask the header
// underneath whether these bytes belong here, and refuse them by name if not.
//
// Nothing is corrupted in any of these cases: every part planted here is copied
// whole or re-sealed after editing, so each one passes its own trailing
// checksum. What the check protects is the diagnosis - without it the operator
// hears that the copy is damaged or the password wrong, about a password that is
// right and media that are healthy - and, where the stranger sits in the slot
// read first, the restore itself, which would otherwise fail on redundancy it
// still had.
//
// These tests pin behaviour rather than wording: which cause is recorded, which
// medium is named, whether the restore survived on redundancy. Where a sentence
// IS matched, it is one describing a different state - ruling it out keeps this
// cause from being filed under an old one. The wording itself, in both
// languages, belongs to smoke.
//
// Messages are asserted in English: t() answers in the default language here,
// no setLang() runs in unit tests.

const VAULT_NAME = 'foreign-part-identity';
/** Correct throughout - so a message about a wrong key would itself be wrong. */
const ENC_PASSWORD = 'correct horse battery staple';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** Directory of medium `pN`, which holds shard N. */
function mediumDir(dirs: string[], index: number): string {
  const dir = dirs[index];
  if (dir === undefined) throw new Error(`fixture has no directory for medium p${index}`);
  return dir;
}

function shardPath(providerDir: string, shardIndex: number, version: number): string {
  return path.join(providerDir, VAULT_NAME, `shard_${shardIndex}.bfs.${version}`);
}

/** Moves a whole part of `fromVersion` over the same index of `toVersion`. */
async function plantOtherVersion(dirs: string[], index: number, fromVersion: number, toVersion: number): Promise<void> {
  await fs.copyFile(shardPath(mediumDir(dirs, index), index, fromVersion), shardPath(mediumDir(dirs, index), index, toVersion));
}

/**
 * Rewrites a part's header through the same serializer that wrote it and
 * re-seals the trailing SHA-256, so the result is a part in perfect condition
 * that merely describes itself differently. Unencrypted vaults only: the
 * location map is re-serialized as plain JSON.
 *
 * Serialization goes through buildHeaderBytes, which writes at the part's OWN
 * format version. Forcing V2 here would rewrite a legacy part into a V2 header
 * over a V1 payload - a part broken in a way no backup can be, which would then
 * be refused for that reason instead of the one under test.
 */
async function reheaderShard(file: string, edit: (header: ShardHeader) => ShardHeader): Promise<void> {
  const buf = await fs.readFile(file);
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(buf));
  payloadStream.on('error', () => {}).destroy();
  const payload = buf.subarray(computeShardHeaderSize(buf), buf.length - SHA256_BYTES);
  const body = Buffer.concat([buildHeaderBytes(edit(header)), payload]);
  await fs.writeFile(file, Buffer.concat([body, Buffer.from(hashBuffer(body), 'hex')]));
}

/**
 * Reads a part's header back off the disk and asserts what it now claims about
 * itself. Every field edited here is one no restore path consults, so an edit
 * that silently failed would look exactly like the defect under test - the
 * restore succeeds and says nothing, either way.
 */
async function expectHeaderClaims(file: string, claims: Partial<Pick<ShardHeader, 'data_shards' | 'parity_shards' | 'blob_hash'>>): Promise<void> {
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(await fs.readFile(file)));
  payloadStream.on('error', () => {}).destroy();
  for (const [field, value] of Object.entries(claims)) {
    expect(header[field as keyof ShardHeader]).toBe(value);
  }
}

/**
 * Runs a restore that is expected to fail and returns the message it failed
 * with. A restore that unexpectedly succeeds says so, instead of leaving an
 * empty string to fail some later assertion for the wrong reason.
 */
async function pullFailureMessage(root: string, io: ProviderIO, options: { version?: number; password?: string } = {}): Promise<string> {
  try {
    await pull(root, { io, force: true, ...options });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('pull was expected to fail, but it succeeded');
}

/** Warnings emitted since `from`, in order. */
function warningsSince(logs: Array<{ level: string; message: string }>, from: number): string[] {
  return logs
    .slice(from)
    .filter((l) => l.level === 'warn')
    .map((l) => l.message);
}

/**
 * Every warning naming the given medium. All of them, not the first: a restore
 * that prints the right sentence and then the old damage notice about the same
 * medium has told the operator two contradictory things, and picking one
 * warning would let that through.
 */
function noticesNaming(warnings: string[], medium: string): string[] {
  return warnings.filter((m) => new RegExp(`\\b${medium}\\b`).test(m));
}

/**
 * Asserts the restore said something about this medium, and that nothing it
 * said sends the operator somewhere the state does not warrant.
 *
 * Both wrong turns are sentences this path really prints, and both are a step
 * away from any fix: damage (`vault_shard_damaged_on_provider`) is what the
 * download loop says for a `ShardCorruptedError`, and absence
 * (`vault_file_missing_on_provider`) is what it says for every other error
 * raised inside its try block - so a refusal signalled by throwing lands there
 * by default. Neither fits: the part is whole and it is on its medium, and each
 * sentence sends the operator to fix something that is not wrong.
 *
 * What is pinned here is the medium being named and the wrong causes not being
 * claimed; the sentence that IS printed for this cause is pinned by smoke, in
 * both languages, so its wording can change without dragging this file along.
 */
function assertNamedWithoutWrongCause(warnings: string[], medium: string, what: string): void {
  const named = noticesNaming(warnings, medium);
  assert(named.length > 0, `restore must name the medium ${what}`);
  for (const notice of named) {
    expect(notice).not.toMatch(/damaged/i);
    expect(notice).not.toMatch(/missing/i);
  }
  // The closing summary is a second place the wrong cause can be claimed, and it
  // names no medium, so the loop above cannot see it. Only the two claims ABOUT
  // THE BYTES are ruled out - each says something untrue of a part that is whole
  // and present, and each sends the operator to fix what is not broken.
  //
  // What is deliberately NOT ruled out is the advice those sentences carry -
  // which command, if any, fits this cause is a question about wording, and
  // barring one here would fail a rewording that is otherwise correct.
  for (const warning of warnings) {
    expect(warning).not.toMatch(/failed its integrity check/i);
    expect(warning).not.toMatch(/was deleted from a healthy provider/i);
  }
}

describe('restore refuses a part belonging to another backup, version or scheme', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;
  let extraRoots: string[];

  /**
   * Pushes v1, then a v2 whose content differs, leaving both versions on the
   * media. v2's parts are the strangers: same names, same shape, another
   * version's identity.
   *
   * v2 is deliberately much larger. Two versions of the same byte count would
   * make a stranger at the first-read index indistinguishable in effect from one
   * further along - both would merely feed wrong bytes to the decode - and the
   * pair of position tests below would stop being a pair.
   */
  async function setup(encrypted: boolean): Promise<void> {
    root = await mkTmp('bfs-foreign-root-');
    pdirs = [await mkTmp('bfs-foreign-alpha-'), await mkTmp('bfs-foreign-beta-'), await mkTmp('bfs-foreign-gamma-')];
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    logs = mock.logs;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: encrypted, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    const password = encrypted ? ENC_PASSWORD : undefined;
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io, ...(password !== undefined ? { password } : {}) });
    await fs.writeFile(path.join(root, 'a.txt'), randomBytes(64 * 1024));
    await push(root, { io, ...(password !== undefined ? { password } : {}) });
  }

  /**
   * A second backup under the same name and shape, on its own media - so its
   * parts differ from this backup's in the vault id and nothing else this check
   * looks at. Returns the path of its part `index` of version 1.
   */
  async function foreignBackupPart(index: number): Promise<string> {
    const otherRoot = await mkTmp('bfs-foreign-other-root-');
    const otherDirs = [await mkTmp('bfs-foreign-other-a-'), await mkTmp('bfs-foreign-other-b-'), await mkTmp('bfs-foreign-other-c-')];
    extraRoots.push(otherRoot, ...otherDirs);
    const mock = createMockProviderIO({}, otherRoot, false);
    await init(otherRoot, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: otherDirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mock.io,
    });
    // Different content from ours, so what lands back in the working directory
    // tells the two apart on its own, rather than resting on the closing hash
    // check to notice.
    await fs.writeFile(path.join(otherRoot, 'a.txt'), 'zzz', 'utf-8');
    await push(otherRoot, { io: mock.io });
    return shardPath(mediumDir(otherDirs, index), index, 1);
  }

  beforeEach(() => {
    root = '';
    pdirs = [];
    logs = [];
    extraRoots = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs, ...extraRoots]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should refuse a part of another version sitting at the index read first', async () => {
    // Half of the A/B pair on position, and the half that decides where the
    // check has to live. The first part to clear its own checksum hands the
    // whole version its blob size and KDF salt, and that happens before any
    // other part is looked at - so a stranger here does not merely supply one
    // wrong part, it speaks for every sound sibling as well. Refused in time,
    // the size comes from a sound part and the parity covers the gap.
    await setup(false);
    await plantOtherVersion(pdirs, 0, 2, 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p0', 'whose part belongs elsewhere');
  });

  it('should refuse a part of another version sitting past the index read first', async () => {
    // The other half of the pair: the size and salt come from a sound part, so
    // nothing is poisoned up front and the stranger is simply decoded as data.
    // Position must not decide whether the check happens - only where its
    // consequences fall.
    await setup(false);
    await plantOtherVersion(pdirs, 1, 2, 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part belongs elsewhere');
  });

  it('should refuse a part of an older version when restoring a later one', async () => {
    // Every other case here restores version 1, and that is a blind spot worth
    // its own case: `config.version` is the CONFIG FORMAT version, a constant 1,
    // so a check comparing a part's version against it instead of against the
    // manifest passes every one of them - and then refuses every part of every
    // version from 2 onwards, on backups that have been pushed to more than
    // once. Restoring in the other direction is what tells the two apart.
    await setup(false);
    const v2Bytes = await fs.readFile(path.join(root, 'a.txt'));
    await fs.copyFile(shardPath(mediumDir(pdirs, 1), 1, 1), shardPath(mediumDir(pdirs, 1), 1, 2));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 2 });

    expect(result.version).toBe(2);
    expect(await fs.readFile(path.join(root, 'a.txt'))).toEqual(v2Bytes);
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part belongs to an earlier version');
  });

  it('should refuse a part carrying another index of this same version', async () => {
    // The index field isolated - one of the three the legacy path has always
    // compared and the current one never has. A parity part moved over a data
    // part's name is a plausible slip: the files sit side by side in one
    // directory and differ by a single character.
    await setup(false);
    await fs.copyFile(shardPath(mediumDir(pdirs, 2), 2, 1), shardPath(mediumDir(pdirs, 1), 1, 1));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part carries another index');
  });

  it('should refuse a stranger sitting on a part the decode does not even need', async () => {
    // The parity part, which a decode with every data part present never opens.
    // Today that makes this the one arrangement where nothing looks wrong at
    // all: the restore succeeds in silence and the operator is never told that
    // one of their media stopped holding a piece of this version - so the
    // redundancy they think they have is not there.
    //
    // It also pins where the check lives. A check inside the decode sees only
    // the parts the decode reads, and would leave this one unexamined.
    await setup(false);
    await plantOtherVersion(pdirs, 2, 2, 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p2', 'whose parity part belongs to another version');
  });

  it('should refuse a part of another backup without calling it an attack', async () => {
    // Another backup of the same name and shape, its part moved under this
    // one's name - the shape a rescue by hand takes when two copies are open at
    // once. The vault id is the only field that separates them.
    //
    // Refusing it must stay as mild as refusing any other stranger: raising a
    // tamper error would kill a restore the parity can still complete, and a
    // foreign copy under our name is deliberately not treated as an attack
    // elsewhere either.
    await setup(false);
    await fs.copyFile(await foreignBackupPart(1), shardPath(mediumDir(pdirs, 1), 1, 1));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'holding a part of another backup');
  });

  it('should refuse a part describing a backup cut into a different number of pieces', async () => {
    // The scheme fields isolated: same backup, same version, same index, and
    // the part re-sealed so its checksum is perfect. Only its own account of
    // how the version was cut disagrees with the manifest.
    //
    // The decode never consults these fields - the geometry comes from the
    // manifest - and this part's payload happens to be the right one, so the
    // restore succeeds whether or not the disagreement is noticed. Only the
    // notice tells the two apart, which is why this case needs its own test.
    await setup(false);
    const planted = shardPath(mediumDir(pdirs, 1), 1, 1);
    // Only the parity count moves here, and only the data count moves in the
    // legacy twin: changing both at once would let a comparison that looks at
    // one field and forgets the other pass on both paths.
    await reheaderShard(planted, (h) => ({ ...h, parity_shards: h.parity_shards + 2 }));
    // Read back what landed on disk. Both the failing and the passing outcome of
    // this test look the same when the edit silently does nothing, so without
    // this the case could be pinning a no-op helper.
    await expectHeaderClaims(planted, { data_shards: 2, parity_shards: 3 });
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part describes another scheme');
  });

  it('should judge the scheme against the version being restored, not the current configuration', async () => {
    // The boundary on the pair of scheme fields, and the one a fix is most
    // likely to cross: a backup can be re-cut, and every version keeps the
    // shape it was written with. Comparing a part against `config.scheme`
    // instead of the manifest would start refusing sound parts of every older
    // version the moment the operator changes the scheme - a failure that
    // arrives long after the change, on the day a restore is needed.
    await setup(false);
    // The shape `bfs provider add` leaves behind: a fourth medium and a wider
    // scheme in the configuration, while version 1 keeps the three media and the
    // cut it was written with.
    const added = await mkTmp('bfs-foreign-delta-');
    extraRoots.push(added);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    config.providers = [...config.providers, localProvider('p3', added)];
    config.scheme = { data_shards: 2, parity_shards: 2 };
    await writeConfig(root, config);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    for (const medium of ['p0', 'p1', 'p2']) {
      expect(noticesNaming(warningsSince(logs, before), medium)).toEqual([]);
    }
  });

  it('should refuse a part describing a different number of data pieces', async () => {
    // The twin of the case above on the other half of the pair. Two fields, and
    // a comparison that reads one and forgets the other is an ordinary slip -
    // so each of them fails a case on its own rather than both moving together.
    await setup(false);
    const planted = shardPath(mediumDir(pdirs, 1), 1, 1);
    await reheaderShard(planted, (h) => ({ ...h, data_shards: h.data_shards + 2 }));
    await expectHeaderClaims(planted, { data_shards: 4, parity_shards: 1 });
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part describes another count of data pieces');
  });

  it('should keep a part whose only difference is the content hash', async () => {
    // The boundary the check stops at, and it has to stop there. An overwrite
    // push that dies before writing the manifest leaves parts of the new
    // content beside a manifest describing the old, all at the same address:
    // same backup, version, index and scheme, only the content hash moved on.
    // Those parts are the version - refusing them would answer "not enough
    // parts" while the media hold a full set. Content is judged after the
    // decode, against the manifest, not by whether a part may be read.
    //
    // What this case does NOT build is the payload side of that state: only the
    // header field moves here, so the bytes still match the hash the manifest
    // records for them. Pre-filtering parts by `manifest.shard_hash`, the way
    // the legacy path does, would therefore pass this test and still break the
    // interrupted overwrite - that route is closed separately, in
    // `architecture/decisions.md` ("Pull wyklucza uszkodzony-ale-obecny shard",
    // among the variants not to revisit).
    await setup(false);
    const planted = shardPath(mediumDir(pdirs, 1), 1, 1);
    const stale = 'f'.repeat(64);
    await reheaderShard(planted, (h) => ({ ...h, blob_hash: stale }));
    await expectHeaderClaims(planted, { blob_hash: stale });
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(noticesNaming(warningsSince(logs, before), 'p1')).toEqual([]);
  });

  it('should refuse a part of another version on an encrypted backup without blaming the password', async () => {
    // The encrypted mirror of the second test, and the case an operator meets
    // first: every push draws a fresh salt, so a part of another version is
    // sealed under another key and fails its GCM tag. That failure is read as a
    // wrong password today - a verdict about the one thing the operator is sure
    // of, which hides the medium actually at fault.
    await setup(true);
    await plantOtherVersion(pdirs, 1, 2, 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1, password: ENC_PASSWORD });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    // The restore going through IS the assertion about the password: the wrong
    // verdict is raised, not warned, so it ends the run. There is nothing to
    // check in the warnings that reaching this line has not already proved.
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part belongs to another version');
  });

  it('should refuse a stranger that would otherwise hand the whole version a foreign salt', async () => {
    // The case the check exists for, and the only arrangement a stranger can
    // still destroy a restore the parity would have carried. The size and the
    // KDF salt are adopted from the first part that clears its own checksum, so
    // a stranger at that index gives the whole version the salt IT was sealed
    // under: the key is then derived from a foreign salt, and every sound part
    // fails its GCM tag alongside the stranger. Not one part lost - all of them,
    // and reported as a wrong password.
    //
    // This is what decides where the check runs. Put it after the key is
    // derived, and the other encrypted case here still passes while this one
    // stays broken.
    await setup(true);
    await plantOtherVersion(pdirs, 0, 2, 1);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1, password: ENC_PASSWORD });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p0', 'whose part would have supplied a foreign salt');
    // The sound media must come through untouched: a foreign salt makes them
    // all fail together, so a single word about either of them here would mean
    // the stranger still spoke for the whole version.
    for (const medium of ['p1', 'p2']) {
      expect(noticesNaming(warningsSince(logs, before), medium)).toEqual([]);
    }
  });

  it('should name the media under their own cause when too few sound parts remain', async () => {
    // Below the threshold the closing sentence is all the operator gets, and it
    // has to carry this cause the way it already carries damage and absence:
    // these media named, and named as holding something that does not belong to
    // this version. Calling it damage sends the operator to a repair that fixes
    // nothing; calling it absence sends them after files that are there.
    await setup(false);
    await plantOtherVersion(pdirs, 0, 2, 1);
    await plantOtherVersion(pdirs, 1, 2, 1);

    const message = await pullFailureMessage(root, io, { version: 1 });

    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    // Every sentence the summary can carry today, ruled out one by one: each
    // describes a state these media are not in, and borrowing any of them lets
    // the new cause hide inside an existing bucket instead of getting its own.
    expect(message).not.toContain('Damaged backup data on:');
    expect(message).not.toContain('Backup data missing on:');
    expect(message).not.toContain('Storage not reachable:');
    expect(message).not.toContain('absent from the configuration');
    expect(message).not.toContain('adapter that is not installed');
    // The parts are unencrypted and whole; a word about a secret would be a
    // second wrong turn on top of the first.
    expect(message).not.toMatch(/password|key/i);
  });

  it('should not ask for a password to open a version it has already run out of parts for', async () => {
    // Where the check runs decides this, so it is worth pinning on its own. The
    // shortage is counted twice - once after the parts are fetched, before the
    // encrypted branch, and once after the key is derived. A check in the
    // fetching phase drops both strangers before the first count, so the run
    // ends without ever asking for a secret; a check placed after the key is
    // derived would take the password first and only then discover there was
    // nothing to unlock. The operator types a secret for a restore that was
    // already over.
    await setup(true);
    await plantOtherVersion(pdirs, 0, 2, 1);
    await plantOtherVersion(pdirs, 1, 2, 1);
    const askSecret = vi.spyOn(io, 'askSecret');
    const loggedBefore = logs.length;

    const message = await pullFailureMessage(root, io, { version: 1 });

    expect(askSecret).not.toHaveBeenCalled();
    expect(logs.slice(loggedBefore).some((l) => l.message.includes('Decrypting'))).toBe(false);
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toContain('Damaged backup data on:');
    expect(message).not.toContain('Backup data missing on:');
    expect(message).not.toContain('Storage not reachable:');
    expect(message).not.toContain('absent from the configuration');
    expect(message).not.toContain('adapter that is not installed');
    // Encryption must not colour the cause: the parts are whole, and a word
    // about a key would send the operator after a secret that is not the
    // problem.
    expect(message).not.toMatch(/password|key/i);
  });
});

/**
 * Builds a genuine FORMAT_VERSION 1 vault by hand - unencrypted, flat (non-striped)
 * Reed-Solomon, V1 headers. Current `push` only writes V2, so a legacy backup can
 * only be produced synthetically. Provider `pN` owns `providerDirs[N]` and shard N.
 */
async function synthesizeV1Vault(opts: { N: number; K: number }): Promise<{ root: string; providerDirs: string[] }> {
  const { N, K } = opts;
  const total = N + K;
  const root = await mkTmp('bfs-foreign-v1-root-');
  const providerDirs: string[] = [];
  for (let i = 0; i < total; i++) providerDirs.push(await mkTmp(`bfs-foreign-v1-p${i}-`));

  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');

  const vaultId = randomUUID();
  const { blob } = await packBlob(root, createIgnoreFilter(root), uuidToBuffer(vaultId));
  const blobHash = hashBuffer(blob.subarray(0, blob.length - SHA256_BYTES));
  const payloads = rsEncode(blob, N, K);

  const providers: ProviderConfig[] = [];
  for (let i = 0; i < total; i++) providers.push(localProvider(`p${i}`, mediumDir(providerDirs, i)));

  const remotePath = (j: number): string => [mediumDir(providerDirs, j), VAULT_NAME, `shard_${j}.bfs.1`].join('/').replace(/\\/g, '/');
  const locationMap: ShardLocation[] = providers.map((pc, j) => ({
    shard_index: j,
    provider_id: pc.id,
    provider_type: 'local',
    adapterPackage: null,
    connection_config: { path: mediumDir(providerDirs, j) },
    required_inputs: null,
    remote_path: remotePath(j),
    shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)),
  }));

  for (let i = 0; i < total; i++) {
    const header: ShardHeader = {
      magic: 'BFSS',
      format_version: 1,
      vault_id: vaultId,
      vault_name: VAULT_NAME,
      blob_size: BigInt(blob.length),
      blob_hash: blobHash,
      data_shards: N,
      parity_shards: K,
      shard_index: i,
      version: 1,
      encrypted: false,
      kdf_salt: null,
      rs_stripe_size: null,
      map_length: 0,
      location_map: locationMap,
    };
    const dir = path.join(mediumDir(providerDirs, i), VAULT_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `shard_${i}.bfs.1`), buildShard(header, payloads[i] ?? Buffer.alloc(0)));
  }

  const config: VaultConfig = {
    vault_id: vaultId,
    vault_name: VAULT_NAME,
    version: 1,
    scheme: { data_shards: N, parity_shards: K },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers,
    max_ram_mb: null,
  };
  await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
  await writeConfig(root, config);
  await writeState(root, { latest_version: 1, working_version: 1 });

  const manifest: VersionManifest = {
    version: 1,
    pushed_at: new Date().toISOString(),
    file_count: 2,
    total_size: 6,
    blob_hash: blobHash,
    scheme: { data_shards: N, parity_shards: K },
    encrypted: false,
    shards: providers.map((pc, j) => ({ shard_index: j, provider_id: pc.id, provider_type: 'local', remote_path: remotePath(j), shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)) })),
    health: VersionHealth.Healthy,
  };
  await writeManifest(root, manifest);

  return { root, providerDirs };
}

describe('the legacy read path judges a stranger by the same fields and the same cause', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;

  beforeEach(async () => {
    const built = await synthesizeV1Vault({ N: 2, K: 1 });
    root = built.root;
    pdirs = built.providerDirs;
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    logs = mock.logs;
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should refuse a legacy part describing another scheme', async () => {
    // The legacy path judges a part by the same five fields as the current one.
    // The scheme pair is the half it did not always compare, and it is the path
    // still reading real backups from the oldest release lines - so the two must
    // not drift apart about the same state.
    const planted = path.join(mediumDir(pdirs, 1), VAULT_NAME, 'shard_1.bfs.1');
    // The data count is the half the V2 twin leaves alone - see the note there.
    await reheaderShard(planted, (h) => ({ ...h, data_shards: h.data_shards + 1 }));
    await expectHeaderClaims(planted, { data_shards: 3, parity_shards: 1 });
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assertNamedWithoutWrongCause(warningsSince(logs, before), 'p1', 'whose part describes another scheme');
  });

  it('should keep refusing a legacy part of another backup', async () => {
    // Green today, and it has to stay green: the legacy path already compares
    // the vault id. Widening that comparison means rewriting the inline check
    // into something shared, and a rewrite that drops one of the three fields it
    // has always had would go unnoticed - nothing else in the suite reads them.
    // This is the net under that rewrite, not a claim about anything missing.
    await reheaderShard(path.join(mediumDir(pdirs, 1), VAULT_NAME, 'shard_1.bfs.1'), (h) => ({ ...h, vault_id: '00000000-0000-4000-8000-000000000000' }));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assert(noticesNaming(warningsSince(logs, before), 'p1').length > 0, 'legacy restore must name the medium holding a part of another backup');
  });

  it('should keep refusing a legacy part carrying another index', async () => {
    // The third of the fields the legacy path already compares, under the same
    // net as the one above.
    await reheaderShard(path.join(mediumDir(pdirs, 1), VAULT_NAME, 'shard_1.bfs.1'), (h) => ({ ...h, shard_index: h.shard_index + 1 }));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    assert(noticesNaming(warningsSince(logs, before), 'p1').length > 0, 'legacy restore must name the medium whose part carries another index');
  });

  it('should judge a legacy part against the version being restored, not the current configuration', async () => {
    // The twin of the V2 boundary, on the path that reads the backups actually
    // written years ago. A fix widening the legacy comparison has the same
    // wrong turn available to it - reaching for `config.scheme` instead of the
    // manifest - and here it would break restores of every version written
    // before the backup was re-cut.
    const added = await mkTmp('bfs-foreign-v1-p3-');
    pdirs.push(added);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    config.providers = [...config.providers, localProvider('p3', added)];
    config.scheme = { data_shards: 2, parity_shards: 2 };
    await writeConfig(root, config);
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    for (const medium of ['p0', 'p1', 'p2']) {
      expect(noticesNaming(warningsSince(logs, before), medium)).toEqual([]);
    }
  });

  it('should keep a legacy part whose only difference is the content hash', async () => {
    // The other twin: the content hash stays outside the identity fields on both
    // read paths, or the two disagree about which parts are usable - and the
    // legacy path is the one with no second opinion available.
    const planted = path.join(mediumDir(pdirs, 1), VAULT_NAME, 'shard_1.bfs.1');
    const stale = 'f'.repeat(64);
    await reheaderShard(planted, (h) => ({ ...h, blob_hash: stale }));
    await expectHeaderClaims(planted, { blob_hash: stale });
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const before = logs.length;

    const result = await pull(root, { io, force: true, version: 1 });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(noticesNaming(warningsSince(logs, before), 'p1')).toEqual([]);
  });

  it('should not close a legacy restore by calling a whole part damaged', async () => {
    // Below the threshold the closing sentence is the whole diagnosis, and on
    // this path it is the one that used to file a whole part under damage -
    // sending the operator to repair something that is not broken. It has to
    // name this cause the same way the current read path does.
    for (const index of [0, 1]) {
      await reheaderShard(path.join(mediumDir(pdirs, index), VAULT_NAME, `shard_${index}.bfs.1`), (h) => ({ ...h, version: h.version + 1 }));
    }

    const message = await pullFailureMessage(root, io, { version: 1 });

    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toContain('Damaged backup data on:');
    expect(message).not.toContain('Backup data missing on:');
    expect(message).not.toContain('Storage not reachable:');
    expect(message).not.toContain('absent from the configuration');
    expect(message).not.toContain('adapter that is not installed');
  });
});
