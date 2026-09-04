import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeShardHeaderSize } from '../../src/core/shard-io.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// When a restore cannot go ahead, the operator's next move depends entirely on
// why: data damaged on a medium calls for a repair, a medium that is offline
// calls for plugging it back in. pull already knows which parts failed and how -
// it builds that map to exclude them from the decode - so the failure it reports
// names the media per cause instead of guessing at one.
//
// The failure text is asserted in English: t() answers in the default language
// here, no setLang() runs in unit tests.

const VAULT_NAME = 'pull-attribution';
/** Passphrase for the encrypted fixtures - correct throughout, so a message about a key would be wrong. */
const ENC_PASSWORD = 'correct horse battery staple';
/** Fixture directories carry no medium names, so an id can only match a real one. */
const DIR_PREFIXES = ['bfs-pull-attr-alpha-', 'bfs-pull-attr-beta-', 'bfs-pull-attr-gamma-'] as const;

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** Flips one payload byte, leaving the trailing checksum stale - bit-rot. */
async function rotShardPayload(file: string): Promise<void> {
  const buf = await fs.readFile(file);
  const pos = computeShardHeaderSize(buf);
  buf[pos] ^= 0xff;
  await fs.writeFile(file, buf);
}

/**
 * Flips one byte of the shard's magic - bit-rot inside the header, so the part
 * is present and readable but its own description of itself no longer parses.
 */
async function rotShardHeader(file: string): Promise<void> {
  const buf = await fs.readFile(file);
  buf[0] ^= 0xff;
  await fs.writeFile(file, buf);
}

function shardPath(providerDir: string, shardIndex: number): string {
  return path.join(providerDir, VAULT_NAME, `shard_${shardIndex}.bfs.1`);
}

/** Directory of medium `pN`, which holds shard N of version 1. */
function mediumDir(dirs: string[], index: number): string {
  const dir = dirs[index];
  if (dir === undefined) throw new Error(`fixture has no directory for medium p${index}`);
  return dir;
}

/** Runs pull and returns the message it failed with. */
async function pullFailure(root: string, io: ProviderIO, password?: string, extra: { allowMissingAdapters?: boolean } = {}): Promise<string> {
  try {
    await pull(root, { io, force: true, ...(password !== undefined ? { password } : {}), ...extra });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('pull was expected to fail, but it succeeded');
}

describe('pull attributes a failed restore to the right cause', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;

  async function setup(encrypted: boolean, password?: string): Promise<void> {
    root = await mkTmp('bfs-pull-attr-root-');
    pdirs = [await mkTmp(DIR_PREFIXES[0]), await mkTmp(DIR_PREFIXES[1]), await mkTmp(DIR_PREFIXES[2])];
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
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io, ...(password !== undefined ? { password } : {}) });
  }

  beforeEach(() => {
    root = '';
    pdirs = [];
    logs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should name the media whose data is damaged, and not blame an offline one', async () => {
    await setup(false);
    await rotShardPayload(shardPath(mediumDir(pdirs, 0), 0));
    await rotShardPayload(shardPath(mediumDir(pdirs, 1), 1));

    const message = await pullFailure(root, io);

    expect(message).toMatch(/damaged|integrity/i);
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toMatch(/\bp2\b/); // the healthy medium must not be implicated
    // Anchored on the sentence an unreachable medium actually prints. The word
    // "offline" appears in none of these messages, so grepping for it would pass
    // no matter how the cause was classified.
    expect(message).not.toContain('Storage not reachable:');
  });

  it('should report missing data as missing, not as damaged', async () => {
    await setup(false);
    await fs.rm(shardPath(mediumDir(pdirs, 0), 0));
    await fs.rm(shardPath(mediumDir(pdirs, 1), 1));

    const message = await pullFailure(root, io);

    expect(message).toMatch(/missing/i);
    expect(message).not.toMatch(/damaged|integrity/i);
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
  });

  it('should separate a damaged medium from a missing one when both occur', async () => {
    await setup(false);
    await rotShardPayload(shardPath(mediumDir(pdirs, 0), 0));
    await fs.rm(shardPath(mediumDir(pdirs, 1), 1));

    const message = await pullFailure(root, io);

    // Each medium must appear under its own cause - one needs a repair, the
    // other needs plugging back in, and the message decides which is which.
    expect(message).toMatch(/damaged|integrity/i);
    expect(message).toMatch(/missing/i);
    const damagedFirst = message.search(/damaged|integrity/i) < message.search(/missing/i);
    const [firstId, secondId] = damagedFirst ? ['p0', 'p1'] : ['p1', 'p0'];
    expect(message.indexOf(firstId)).toBeLessThan(message.indexOf(secondId));
  });

  it('should report a part whose header is damaged as damaged, not as absent', async () => {
    // Damage inside the header is still damage: the file is on the medium and
    // reads back fine, only its own description of itself is rotted. Reporting
    // it as absent sends the operator hunting for a medium that never left.
    await setup(false);
    await rotShardHeader(shardPath(mediumDir(pdirs, 0), 0));
    await rotShardHeader(shardPath(mediumDir(pdirs, 1), 1));

    const message = await pullFailure(root, io);

    expect(message).toMatch(/damaged|integrity/i);
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toMatch(/missing/i);
  });

  it('should report every part damaged as a shortage of usable parts, naming the media', async () => {
    // Every part fails its own checksum, so none can supply the size the restore
    // is sized against. Nothing has recorded a cause at that point - the part
    // consulted for the size defers to a sibling on failure without noting it,
    // and the integrity pass has not run yet - so the restore has to reach the
    // same conclusion it reaches for any other unusable set of parts: too few
    // parts left, and the damaged media named, rather than a message of its own
    // about an unreadable size that leaves the operator with nowhere to go.
    //
    // A rebuild reads N sound parts and none are left, so pointing the operator
    // at `bfs repair --rebuild` here sends them after a command that refuses on
    // the same shortage. The message states instead that this version can no
    // longer be restored from what the media still hold. The wording itself, and
    // its EN/PL pair, belong to smoke - asserted here only as: no rebuild
    // advised, and the impossibility said out loud.
    await setup(false);
    for (let i = 0; i < 3; i++) {
      await rotShardPayload(shardPath(mediumDir(pdirs, i), i));
    }

    const message = await pullFailure(root, io);

    expect(message).toMatch(/not enough/i);
    expect(message).toMatch(/damaged|integrity/i);
    expect(message).not.toMatch(/bfs repair/);
    expect(message).toMatch(/cannot|can't|no longer|not possible|impossible|unable/i);
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).toMatch(/\bp2\b/);
    expect(message).not.toMatch(/backup size/i);
  });

  it('should name the media that never answered, without calling their data damaged or absent', async () => {
    // A medium that is switched off delivered nothing, so nothing is known about
    // the state of the part it holds. Calling that data damaged sends the
    // operator to repair bytes nobody read; calling it missing sends them
    // looking for a file that is most likely still there. Both readings cost the
    // operator a wasted move, so the cause gets a sentence of its own - and this
    // is the assertion that it is actually emitted, which no layer had before.
    await setup(false);
    await fs.rm(mediumDir(pdirs, 0), { recursive: true, force: true });
    await fs.rm(mediumDir(pdirs, 1), { recursive: true, force: true });

    const message = await pullFailure(root, io);

    expect(message).toContain('Storage not reachable:');
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toContain('Damaged backup data on:');
    expect(message).not.toContain('Backup data missing on:');
  });

  it('should name a medium the configuration no longer lists when too few parts survive', async () => {
    // The degraded restore already names this medium; the failed one did not,
    // although it is the same recoverable mistake and the same fix. Here the
    // shortage is reached with two different causes at once, so the message has
    // to carry both sentences rather than collapse them into the louder one.
    await setup(false);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    const detached = config.providers[2];
    assert(detached !== undefined, 'fixture vault must have a third medium');
    config.providers = [...config.providers.slice(0, 2), { ...detached, id: 'p2-renamed' }];
    await writeConfig(root, config);
    await fs.rm(shardPath(mediumDir(pdirs, 0), 0));

    const message = await pullFailure(root, io);

    expect(message).toContain('absent from the configuration');
    // The name recorded in the backup, not the renamed entry - that is the one
    // the operator has to restore for the degradation to go away.
    expect(message).toMatch(/\bp2\b(?!-)/);
    expect(message).toContain('Backup data missing on:');
    expect(message).toMatch(/\bp0\b/);
  });

  it('should name a medium whose adapter is not installed when too few parts survive', async () => {
    // Reached only past the preflight, which refuses outright unless the run
    // opted into carrying on without the adapter. Past that point the part is
    // simply unavailable, and the reason has to survive into the failure - "not
    // enough parts" alone would hide the one cause fixed by an `npm install`
    // rather than by touching any storage.
    await setup(false);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    const external = config.providers[2];
    assert(external !== undefined, 'fixture vault must have a third medium');
    config.providers = [...config.providers.slice(0, 2), { ...external, type: 'ghost-cloud', adapterPackage: 'bfs-adapter-ghost' }];
    await writeConfig(root, config);
    await fs.rm(shardPath(mediumDir(pdirs, 0), 0));

    const message = await pullFailure(root, io, undefined, { allowMissingAdapters: true });

    expect(message).toContain('adapter that is not installed');
    expect(message).toMatch(/\bp2\b/);
    expect(message).toContain('Backup data missing on:');
    expect(message).toMatch(/\bp0\b/);
  });

  it('should restore from the surviving parts when enough of them are still sound', async () => {
    // The counterpart of the case above, and the boundary the advice to rebuild
    // hangs on: one part rots while N sound ones remain - which is both what the
    // decode needs and what a rebuild would read. The restore goes ahead, so the
    // shortage message never fires while enough parts survive.
    await setup(false);
    await rotShardPayload(shardPath(mediumDir(pdirs, 0), 0));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const loggedBefore = logs.length;

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    const warnings = logs
      .slice(loggedBefore)
      .filter((l) => l.level === 'warn')
      .map((l) => l.message);
    expect(warnings.some((m) => /integrity|damaged/i.test(m))).toBe(true);
  });

  it('should name the medium whose part the integrity pass rejected', async () => {
    // Which medium holds rotted data is the one thing the operator needs from a
    // degraded restore, and it must not depend on the order the parts happen to
    // be read in. The size the restore is sized against is adopted from the
    // first part that passes its own checksum, and the parts are read in
    // manifest order - so shard 0 on p0 supplies it here and p1's rotted part is
    // reached only by the main integrity pass, which drops it and names nobody.
    await setup(false);
    await rotShardPayload(shardPath(mediumDir(pdirs, 1), 1));
    await fs.writeFile(path.join(root, 'a.txt'), 'clobbered', 'utf-8');
    const loggedBefore = logs.length;

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    const warnings = logs
      .slice(loggedBefore)
      .filter((l) => l.level === 'warn')
      .map((l) => l.message);
    // The generic note that the pool is degraded names no medium, so satisfying
    // this needs a warning that says which one - and it must be the rotted one,
    // not a sound sibling.
    const named = warnings.find((m) => /damaged|integrity/i.test(m) && /\bp1\b/.test(m));
    assert(named !== undefined, 'restore must name the medium whose part was rejected as damaged');
    expect(named).not.toMatch(/\bp0\b/);
    expect(named).not.toMatch(/\bp2\b/);
  });

  it('should tell the operator how to bring back a medium the configuration no longer lists', async () => {
    // A medium the backup records but the configuration has lost is the one
    // degradation an operator can undo without touching any data - so the
    // restore that survived it must name that medium and the command that puts
    // it back, in a warning of its own rather than folded into the note about
    // the part it skipped.
    await setup(false);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    const detached = config.providers[2];
    assert(detached !== undefined, 'fixture vault must have a third medium');
    config.providers = [...config.providers.slice(0, 2), { ...detached, id: 'p2-renamed' }];
    await writeConfig(root, config);
    const loggedBefore = logs.length;

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    const warnings = logs
      .slice(loggedBefore)
      .filter((l) => l.level === 'warn')
      .map((l) => l.message);
    // The skip note states what the restore did with the part; the advice states
    // what the operator does about it. Two different things to say, so folding
    // the advice into the note would not satisfy this.
    const skipNote = warnings.find((m) => /skipping/i.test(m));
    assert(skipNote !== undefined, 'restore must note the part it skipped');
    const advice = warnings.find((m) => m !== skipNote && /bfs repair\b/.test(m));
    assert(advice !== undefined, 'restore must warn how to bring the lost medium back');
    // Naming only the renamed entry would leave the operator guessing which of
    // the recorded media went missing, so the backup's own name for it is what
    // this asserts.
    expect(advice).toMatch(/\bp2\b(?!-)/);
  });

  it('should offer both ways forward for a medium the configuration no longer lists', async () => {
    // The same branch fires for two opposite situations: a name lost from the
    // configuration by accident, and a medium deliberately dropped from the pool
    // - after `bfs provider remove --strategy remove` the older versions still
    // record it. Advice that only says "put that name back" tells the second
    // operator to undo the very thing they just did, and contradicts the step
    // the removal itself printed: make a fresh copy on the media that remain.
    // So the advice has to carry both routes, and let the operator pick the one
    // that matches what happened.
    await setup(false);
    const config = await readConfig(root);
    assert(config !== null, 'fixture vault must have a config on disk');
    const detached = config.providers[2];
    assert(detached !== undefined, 'fixture vault must have a third medium');
    config.providers = [...config.providers.slice(0, 2), { ...detached, id: 'p2-renamed' }];
    await writeConfig(root, config);
    const loggedBefore = logs.length;

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    const warnings = logs
      .slice(loggedBefore)
      .filter((l) => l.level === 'warn')
      .map((l) => l.message);
    const advice = warnings.find((m) => !/skipping/i.test(m) && /\bp2\b(?!-)/.test(m));
    assert(advice !== undefined, 'restore must advise on the medium the configuration lost');
    // Both routes in the same breath: bring the recorded name back, or leave it
    // gone and make a sound copy on what is left. Exact wording is smoke's job.
    expect(advice).toMatch(/bfs repair\b/);
    expect(advice).toMatch(/bfs push\b/);
  });

  // The two tests below are one pair, and splitting them apart or merging them
  // would lose what they are for. On an encrypted backup the shortage can be
  // reached at two different points, and WHICH one depends on where the damage
  // sits. The size and salt the restore needs are adopted from the first part
  // that clears its own checksum, and that happens before the password is ever
  // asked for. So damage covering the early parts trips the shortage while the
  // vault is still, as far as the code has got, an unopened one - whereas damage
  // behind a sound first part trips it after the key was already derived. Only
  // one of the two runs the attribution through the decryption machinery, so a
  // test pinning either one alone pins the easy half.
  it('should name the damaged media on an encrypted backup without asking for the password', async () => {
    // Damage covers the parts consulted for the size, so the shortage is reached
    // before the encrypted branch. Being asked to type a password here would be
    // asking for a secret to unlock a restore that has already run out of parts.
    await setup(true, ENC_PASSWORD);
    await rotShardPayload(shardPath(mediumDir(pdirs, 0), 0));
    await rotShardPayload(shardPath(mediumDir(pdirs, 1), 1));
    const askSecret = vi.spyOn(io, 'askSecret');
    const loggedBefore = logs.length;

    const message = await pullFailure(root, io);

    expect(message).toContain('Damaged backup data on:');
    expect(message).toMatch(/\bp0\b/);
    expect(message).toMatch(/\bp1\b/);
    expect(message).not.toMatch(/\bp2\b/);
    // Encryption must not colour the cause: the parts are rotted, and saying
    // anything about a key or a password would send the operator after a secret
    // that is not the problem.
    expect(message).not.toMatch(/password|key/i);
    expect(askSecret).not.toHaveBeenCalled();
    // The counterpart of the assertion in the next test, and what makes the two
    // a pair rather than a duplicate: this run never entered the encrypted
    // branch at all.
    expect(logs.slice(loggedBefore).some((l) => l.message.includes('Decrypting'))).toBe(false);
  });

  it('should name the damaged media on an encrypted backup after a sound part supplied the salt', async () => {
    // The mirror image: part 0 is sound, so it hands over the size and salt, the
    // password is taken and the key derived - and only then does the integrity
    // pass drop the two rotted parts and reach the same shortage. The attribution
    // has to read the same as it does on the branch above.
    await setup(true, ENC_PASSWORD);
    await rotShardPayload(shardPath(mediumDir(pdirs, 1), 1));
    await rotShardPayload(shardPath(mediumDir(pdirs, 2), 2));
    const loggedBefore = logs.length;

    const message = await pullFailure(root, io, ENC_PASSWORD);

    // Proof this really is the other branch: the key was derived before the
    // shortage was reached. Without it the two tests could both be exercising
    // the early exit and neither would say so.
    expect(logs.slice(loggedBefore).some((l) => l.message.includes('Decrypting'))).toBe(true);
    expect(message).toContain('Damaged backup data on:');
    expect(message).toMatch(/\bp1\b/);
    expect(message).toMatch(/\bp2\b/);
    expect(message).not.toMatch(/\bp0\b/);
    // The password was correct and the key derived - a decryption error surfacing
    // here would tell the operator they mistyped it.
    expect(message).not.toMatch(/password|key/i);
  });

  it('should still report a wrong password as a password problem', async () => {
    // A wrong key fails every part at once. Reporting that as "these media are
    // damaged" would send the operator to repair perfectly good data - the
    // distinction between corruption and a wrong password is a closed decision.
    await setup(true, 'correct horse battery staple');

    const message = await pullFailure(root, io, 'wrong password entirely');

    expect(message).toMatch(/password|key/i);
    expect(message).not.toMatch(/\bp0\b.*\bp1\b/s);
  });
});
