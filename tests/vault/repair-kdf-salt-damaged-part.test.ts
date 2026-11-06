import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { DecryptionError, LockConcurrentActiveError, ShardCorruptedError, TamperDetectedError } from '../../src/core/errors.js';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
// Importing the module also registers the `local` provider type.
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, RepairPair } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { repairVault } from '../../src/vault/repair.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

// Every part of one version carries the SAME Argon2id salt, so the key that opens
// the version's location map can be derived from any of them. A bit-rot in that
// salt on ONE part therefore costs exactly that part: its own map no longer opens,
// while every sibling still carries the version's real salt and opens with the
// correct password.
//
// `repair` resolves the vault password before it touches anything. Judged on the
// FIRST reachable part alone, a damaged salt there would report the correct
// password as not matching - and the one command that rebuilds the damaged part
// would refuse to run because of the very damage it fixes. So once a password
// has failed on the first part, it is tried on the other reachable parts of the
// push the version records - the storages under repair excepted - the whole pool
// first, then the prompt, each typed answer tried on every part. A version whose
// first part opens reads nothing more. A wrong password still opens nothing and
// is refused; a foreign or misfiled first part is still refused before any
// password is tried.

const VAULT = 'vault';
const PASSWORD = 'salt-repair-secret';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-repair-salt-'));
}

function provider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function shardPath(dir: string, index: number, version: number): string {
  return path.join(dir, VAULT, `shard_${index}.bfs.${version}`);
}

/** Reads the KDF salt from the header of one part on disk. */
async function saltOf(file: string): Promise<Buffer> {
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(await fs.readFile(file)));
  payloadStream.on('error', () => {}).destroy();
  assert(header.kdf_salt !== null, `${file} must be an encrypted part carrying a salt`);
  return header.kdf_salt;
}

/**
 * Flips one byte of the KDF salt in a part's header, in place, WITHOUT
 * recomputing the part's trailing checksum - the shape bit-rot leaves behind.
 * The header still parses; only the key derived from it is wrong.
 */
async function damageSalt(file: string): Promise<void> {
  const bytes = await fs.readFile(file);
  const salt = await saltOf(file);
  const at = bytes.indexOf(salt);
  assert(at >= 0, 'the salt must be found in the part header');
  bytes[at] = (bytes[at] ?? 0) ^ 0xff;
  await fs.writeFile(file, bytes);
}

/** Encrypted 2+1 vault on p0/p1/p2 with one pushed version. */
async function buildEncryptedVault(dirs: string[]): Promise<{ root: string; io: ProviderIO }> {
  const root = await tmp();
  const io = createMockProviderIO({}, root, false).io;
  await init(root, {
    vault_name: VAULT,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.map((dir, i) => provider(`p${i}`, dir)),
    push_mode: PushMode.NewVersion,
    io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io, password: PASSWORD });
  return { root, io };
}

/** The pair `bfs repair --version 1 p0 "" --rebuild` builds: same id, location kept. */
function rebuildInPlace(id: string): RepairPair {
  return { oldName: id, params: '', rawParams: [], isMigration: false, newConfig: null };
}

describe('repair --rebuild of a part whose header carries a damaged KDF salt', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    dirs = [];
  });

  it('should seed a damaged part whose salt differs from its siblings', async () => {
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    const healthySalt = await saltOf(shardPath(s1, 1, 1));

    await damageSalt(shardPath(s0, 0, 1));

    expect((await saltOf(shardPath(s0, 0, 1))).equals(healthySalt), 'the damaged part must carry a salt its siblings do not').toBe(false);
    expect((await saltOf(shardPath(s1, 1, 1))).equals(healthySalt), 'the sibling keeps the version salt').toBe(true);
  });

  it('should rebuild the damaged part with the correct password when it is the first reachable part', async () => {
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    const healthySalt = await saltOf(shardPath(s1, 1, 1));
    // p0 is listed first in the v1 manifest, so it is the part repair probes first.
    await damageSalt(shardPath(s0, 0, 1));
    const { io, logs } = createMockProviderIO({}, root, false);

    const result = await repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false });

    expect(
      logs.filter((l) => l.level === 'warn' && l.message === fmt('repair_pool_password_failed', '1')),
      'the supplied password opens a sibling - telling the operator it decrypts nothing is false',
    ).toEqual([]);
    expect(result.failed_pairs, 'rebuilding the damaged part must succeed - the correct password opens every healthy sibling').toEqual([]);
    expect(result.failed_shards, 'an in-place rebuild reports its failures per part - none may be left').toEqual([]);
    expect((await saltOf(shardPath(s0, 0, 1))).equals(healthySalt), 'the rebuilt part must carry the version salt again').toBe(true);
    const status = await verifyVersion(root, 1, io, { deep: true });
    expect(status.health, 'a deep check after the rebuild must find every part intact').toBe(VersionHealth.Healthy);
  });

  it('should accept the correct password typed at the prompt when the damaged part is the first reachable part', async () => {
    // An operator at a terminal who chooses to rebuild the part reaches this
    // command through the password prompt. The prompt has to be judged against a
    // part whose map can open, not against the damaged one.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    const healthySalt = await saltOf(shardPath(s1, 1, 1));
    await damageSalt(shardPath(s0, 0, 1));
    const io = createMockProviderIO({ [fmt('repair_ask_vault_password', '1')]: PASSWORD }, root, true).io;
    const askSecret = vi.spyOn(io, 'askSecret');

    const result = await repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: [], rebuild: true, forceUnverified: false });

    // One question, answered once. A prompt judged against the damaged part
    // first answers the correct password with "wrong password - try again", and
    // retyping it loops there forever on a real terminal.
    expect(
      askSecret.mock.calls.map((c) => c[0]),
      'the operator is asked once and never told the correct password is wrong',
    ).toEqual([fmt('repair_ask_vault_password', '1')]);
    expect(result.failed_pairs, 'the correct password typed at the prompt must be accepted').toEqual([]);
    expect(result.failed_shards, 'no part may be left unrebuilt').toEqual([]);
    expect((await saltOf(shardPath(s0, 0, 1))).equals(healthySalt), 'the rebuilt part must carry the version salt again').toBe(true);
  });

  it('should not prompt at a terminal when the supplied password opens a sibling of the damaged first part', async () => {
    // `bfs repair ... --password <correct>` typed at a terminal: the supplied
    // password settles it on a sibling, so the operator is never asked - a
    // prompt here would mean the damaged part was judged before the pool was
    // tried on the rest.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    const healthySalt = await saltOf(shardPath(s1, 1, 1));
    await damageSalt(shardPath(s0, 0, 1));
    const io = createMockProviderIO({}, root, true).io;
    const askSecret = vi.spyOn(io, 'askSecret');

    const result = await repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false });

    expect(
      askSecret.mock.calls.map((c) => c[0]),
      'the supplied password opens a sibling - nothing is asked',
    ).toEqual([]);
    expect(result.failed_pairs).toEqual([]);
    expect(result.failed_shards).toEqual([]);
    expect((await saltOf(shardPath(s0, 0, 1))).equals(healthySalt), 'the rebuilt part must carry the version salt again').toBe(true);
  });

  it('should accept the correct password typed at the prompt on an undamaged backup', async () => {
    // Control for the prompt case above: proves the scripted answer reaches the
    // prompt at all, so a refusal there is the damaged part, not the fixture.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const io = createMockProviderIO({ [fmt('repair_ask_vault_password', '1')]: PASSWORD }, root, true).io;
    const askSecret = vi.spyOn(io, 'askSecret');

    const result = await repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: [], rebuild: true, forceUnverified: false });

    expect(
      askSecret.mock.calls.map((c) => c[0]),
      'the spy must see exactly the one prompt',
    ).toEqual([fmt('repair_ask_vault_password', '1')]);
    expect(result.failed_pairs).toEqual([]);
    expect(result.failed_shards).toEqual([]);
  });

  it('should rebuild a damaged part that is not the first reachable part', async () => {
    // A/B against the first-part case: here the first part is intact, so the
    // password check passes on it and only the rebuild itself is exercised.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    const healthySalt = await saltOf(shardPath(s0, 0, 1));
    await damageSalt(shardPath(s1, 1, 1));

    const result = await repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false });

    expect(result.failed_pairs).toEqual([]);
    expect(result.failed_shards).toEqual([]);
    expect((await saltOf(shardPath(s1, 1, 1))).equals(healthySalt), 'the rebuilt part must carry the version salt again').toBe(true);
    const status = await verifyVersion(root, 1, io, { deep: true });
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should still refuse outright when the first reachable part belongs to another backup', async () => {
    // Reaching past a part whose map does not open is for settling the password
    // only. A part of ANOTHER backup in first position - same name, same
    // password, copied or synced there - is still refused as foreign before any
    // password is tried, not skipped as one more unopenable part.
    const storages = [await tmp(), await tmp(), await tmp()];
    const otherStorages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    const other = await buildEncryptedVault(otherStorages);
    dirs = [root, ...storages, other.root, ...otherStorages];
    const [s0] = storages;
    const [o0] = otherStorages;
    assert(s0 !== undefined && o0 !== undefined, 'fixtures must have three storages');
    await fs.copyFile(shardPath(o0, 0, 1), shardPath(s0, 0, 1));

    await expect(repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false })).rejects.toThrow(TamperDetectedError);
  });

  it('should still refuse outright when the first reachable part is filed under another index', async () => {
    // The second hard refusal of the password check: a part whose header does
    // not match the name it is stored under (here the p1 part copied over p0's)
    // is reported as such, not skipped as one more part whose map does not open.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, s1] = storages;
    assert(s0 !== undefined && s1 !== undefined, 'fixture must have three storages');
    await fs.copyFile(shardPath(s1, 1, 1), shardPath(s0, 0, 1));

    await expect(repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false })).rejects.toThrow(ShardCorruptedError);
  });

  it('should still refuse a wrong password typed at the prompt, asking again once', async () => {
    // Control for the prompt path: reaching past the damaged part must keep the
    // retry the prompt offers and end in a refusal when the operator skips it -
    // neither accept a wrong password nor loop over the parts asking again.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0] = storages;
    assert(s0 !== undefined, 'fixture must have three storages');
    await damageSalt(shardPath(s0, 0, 1));
    const before = await fs.readFile(shardPath(s0, 0, 1));
    // The retry prompt is left unanswered, which skips it.
    const io = createMockProviderIO({ [fmt('repair_ask_vault_password', '1')]: 'not-the-password' }, root, true).io;
    const askSecret = vi.spyOn(io, 'askSecret');

    await expect(repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: [], rebuild: true, forceUnverified: false })).rejects.toThrow(DecryptionError);

    expect(
      askSecret.mock.calls.map((c) => c[0]),
      'one question and one retry, then the refusal',
    ).toEqual([fmt('repair_ask_vault_password', '1'), fmt('repair_wrong_vault_password_retry', '1')]);
    expect(Buffer.compare(await fs.readFile(shardPath(s0, 0, 1)), before), 'a refused repair must leave the damaged part as it was').toBe(0);
  });

  it('should still refuse a password that opens no part of the version', async () => {
    // Control: reaching past the damaged part must not turn into accepting any
    // password - a wrong one opens no sibling either, so repair still refuses.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0] = storages;
    assert(s0 !== undefined, 'fixture must have three storages');
    await damageSalt(shardPath(s0, 0, 1));
    const before = await fs.readFile(shardPath(s0, 0, 1));

    await expect(repairVault(root, { pairs: [rebuildInPlace('p0')], versions: [1], io, passwords: ['not-the-password'], rebuild: true, forceUnverified: false })).rejects.toThrow(DecryptionError);

    expect(Buffer.compare(await fs.readFile(shardPath(s0, 0, 1)), before), 'a refused repair must leave the damaged part as it was').toBe(0);
  });

  it('should read no other part when the password opens the first one', async () => {
    // The other parts are read only after a password has failed. On a healthy
    // backup the first part settles it, so a storage further down - here one
    // whose base directory is gone - is not touched before the lock; a local
    // storage would otherwise recreate that directory unasked. A live
    // repair.lock stops the run right after the password check, so nothing
    // later can touch that storage either.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [, , s2] = storages;
    assert(s2 !== undefined, 'fixture must have three storages');
    await fs.rm(s2, { recursive: true, force: true });
    const liveLock = { format_version: 1, operation: 'repair', version_range: '1', pid: process.pid, command: 'repair', started_at: new Date().toISOString(), succeeded_pairs: [], failed_pairs: [], failed_shards: [] };
    await fs.writeFile(path.join(root, '.bfs', 'repair.lock'), JSON.stringify(liveLock), 'utf-8');

    await expect(repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [PASSWORD], rebuild: true, forceUnverified: false })).rejects.toThrow(LockConcurrentActiveError);

    await expect(fs.access(s2), 'a storage the password check did not need must not be reached').rejects.toThrow();
  });

  it('should read no other part when no password can be tried at all', async () => {
    // `--ci` without a password: nothing is tried, so there is nothing to look
    // further for - the refusal comes without reaching the other storages.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, , s2] = storages;
    assert(s0 !== undefined && s2 !== undefined, 'fixture must have three storages');
    await damageSalt(shardPath(s0, 0, 1));
    await fs.rm(s2, { recursive: true, force: true });

    await expect(repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [], rebuild: true, forceUnverified: false })).rejects.toThrow(DecryptionError);

    await expect(fs.access(s2), 'a run that tries no password must not reach further storages').rejects.toThrow();
  });

  it('should not settle the password on a part of another push', async () => {
    // v1 overwritten under a new password while p2 kept its earlier part, then
    // p0's salt rotted and p1 is the part being rebuilt. The only other part
    // that opens is p2's - under the OLD password, which opens none of the parts
    // this version records. Accepting it would let the rebuild start and fail
    // half-way; the refusal belongs before anything is locked.
    const NEW_PASSWORD = 'salt-repair-rotated';
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    dirs = [root, ...storages];
    const [s0, , s2] = storages;
    assert(s0 !== undefined && s2 !== undefined, 'fixture must have three storages');
    const earlier = await fs.readFile(shardPath(s2, 2, 1));
    await fs.writeFile(path.join(root, 'a.txt'), 'overwritten', 'utf-8');
    await push(root, { io, password: NEW_PASSWORD, mode: PushMode.Overwrite });
    await fs.writeFile(shardPath(s2, 2, 1), earlier);
    await damageSalt(shardPath(s0, 0, 1));

    await expect(repairVault(root, { pairs: [rebuildInPlace('p1')], versions: [1], io, passwords: [NEW_PASSWORD, PASSWORD], rebuild: true, forceUnverified: false })).rejects.toThrow(DecryptionError);

    await expect(fs.access(path.join(root, '.bfs', 'repair.lock')), 'the refusal comes before the lock').rejects.toThrow();
  });

  it('should not reach for the abandoned location of the storage being repaired', async () => {
    // Settling the password past a damaged first part reads the other parts -
    // but never the one under repair: its recorded location is the one being
    // replaced. A storage whose base directory moved would otherwise be asked
    // for at the old path, which a local storage recreates there unasked.
    const storages = [await tmp(), await tmp(), await tmp()];
    const { root, io } = await buildEncryptedVault(storages);
    const moved = await tmp();
    dirs = [root, ...storages, moved];
    const [s0, , s2] = storages;
    assert(s0 !== undefined && s2 !== undefined, 'fixture must have three storages');
    await damageSalt(shardPath(s0, 0, 1));
    await fs.rm(moved, { recursive: true, force: true });
    await fs.rename(s2, moved);
    const relocate: RepairPair = { oldName: 'p2', params: `--path ${moved}`, rawParams: ['--path', moved], isMigration: false, newConfig: null };

    const result = await repairVault(root, { pairs: [relocate], versions: [1], io, passwords: [PASSWORD], rebuild: false, forceUnverified: false });

    expect(result.failed_pairs, 'the relocation itself must go through').toEqual([]);
    await expect(fs.access(s2), 'the abandoned base directory must not be recreated').rejects.toThrow();
  });
});
