import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PushSkippedError } from '../../src/core/errors.js';
// Side-effect import: registers the built-in local provider in the global
// registry, the way src/index.ts does in production.
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { readState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// A backup has two volumes underneath it and they fail independently: the
// system temp, where push stages parity parts and pull stages downloaded ones,
// and the backup's own cache directory, where the packed blob (push) and the
// restored blob (pull) are written. Each names itself when it refuses: the
// directory at fault, the one command that moves it, and the operating system's
// own reason kept around both - the reason alone cannot say which disk it was,
// and dropping it would lose what separates a full volume from a read-only one.
// These tests hold that split, because a bare errno on a path leaves the
// operator guessing at both.
//
// A refusal reaches the pack in several shapes and each is staged here, because
// a fix that covers one leaves the others reporting the wrong thing. The open
// can fail - staged by putting a directory where the blob file belongs, whose
// parent exists so every directory check passes - or the open can succeed and a
// later write fail, which is how a volume that fills mid-copy behaves. That
// second shape splits again in the compressed pack, where each file costs three
// writes and refusing a different one leaves behind a different kind of damage.
// None of them is a real ENOSPC, and all can be staged on every platform the
// project runs on.

const CACHE_DIR_HINT = 'bfs config --cache-dir';
const TEMP_DIR_HINT = 'bfs config --temp-dir';

// The uncompressed disk pack writes the blob through a file handle, one user
// file at a time, and a volume that fills does so partway through - the open
// succeeded, a later write did not. Blocking the path from outside cannot
// reproduce that: it fails the open instead, which is a different site. The
// first write lays down the header placeholder and is let through, so the
// fault lands where a real ENOSPC lands - inside the per-file copy loop.
// `failAtKind` selects the second mode, used by the compressed pack below. A
// volume that stays full is not the shape that hurts there: it also refuses
// finalize(), so the pack aborts and the refusal is reported correctly. The
// damaging shape is a write that fails ONCE and lets the rest through - the
// pack then completes and seals a blob whose ZIP stream lost a member.
//
// Which of the three writes addFile makes per file is refused decides what
// survives, so the fault has to be aimed rather than left to land anywhere.
// They are told apart by the ZIP signature each one opens with, not by size:
// a small file compresses to a payload no bigger than a header, so sizes put
// the count off by one and the fault lands one file past the intended one.
// Compressed bytes would have to open with all four signature bytes to be
// mistaken for a header, which random payloads of this size do not.
const SIG_LFH = 0x04034b50;
const SIG_DD = 0x08074b50;
const outputFault = vi.hoisted(() => ({ armed: false, writes: 0, hit: [] as string[], seen: 0, hitAt: 0, failAtKind: null as Nullable<'lfh' | 'data' | 'dd'>, failAtOccurrence: 0, code: 'ENOSPC' }));
const readFault = vi.hoisted(() => ({ path: null as Nullable<string>, code: 'EACCES' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeRefusal = (): NodeJS.ErrnoException => {
    const code = outputFault.code;
    const err: NodeJS.ErrnoException = new Error(`${code}: ${code === 'ENOSPC' ? 'no space left on device' : 'permission denied'}, write`);
    err.code = code;
    err.syscall = 'write';
    return err;
  };
  const open = (async (p: unknown, flags: unknown, mode: unknown) => {
    const handle = await actual.open(p as never, flags as never, mode as never);
    if (!outputFault.armed || typeof p !== 'string' || !/push\.blob\.pending$/.test(p)) return handle;
    return new Proxy(handle, {
      get(target, prop, receiver) {
        if (prop === 'write') {
          return async (...args: unknown[]) => {
            outputFault.writes += 1;
            const passThrough = () => (target.write as (...a: never[]) => unknown)(...(args as never[]));
            if (outputFault.failAtKind !== null) {
              const buf = args[0];
              // The placeholder goes through untouched; classifying it would put
              // a header-sized write ahead of the first real local header.
              if (outputFault.writes > 1 && Buffer.isBuffer(buf) && buf.length >= 4) {
                const sig = buf.readUInt32LE(0);
                const kind = sig === SIG_LFH ? 'lfh' : sig === SIG_DD ? 'dd' : 'data';
                if (kind === outputFault.failAtKind) {
                  outputFault.seen += 1;
                  if (outputFault.seen === outputFault.failAtOccurrence) {
                    // Recorded at the moment of refusal: the loop carries on
                    // afterwards, so the running counter no longer says where
                    // the fault actually landed.
                    outputFault.hitAt = outputFault.seen;
                    outputFault.hit.push(p);
                    throw writeRefusal();
                  }
                }
              }
              return passThrough();
            }
            if (outputFault.writes === 1) return passThrough();
            outputFault.hit.push(p);
            throw writeRefusal();
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }) as typeof actual.open;
  // The other direction through the same loop. A source file that cannot be read
  // is a skipped file and must stay one - that is the behaviour a fix separating
  // the two directions must not take away.
  const readFile = (async (p: unknown, options: unknown) => {
    if (readFault.path !== null && typeof p === 'string' && path.resolve(p) === path.resolve(readFault.path)) {
      const code = readFault.code;
      const err: NodeJS.ErrnoException = new Error(`${code}: ${code === 'ENOSPC' ? 'no space left on device' : 'permission denied'}, open '${p}'`);
      err.code = code;
      err.syscall = 'open';
      throw err;
    }
    return (actual.readFile as (...a: never[]) => unknown)(p as never, options as never);
  }) as typeof actual.readFile;
  const patched = { ...actual, open, readFile };
  return { ...patched, default: patched };
});

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

// Disarmed for every test in this file, not just the block that arms it: a flag
// left set would fire inside the next test's fixture, moving what its failure
// proves - and the next test may live in another describe.
afterEach(() => {
  outputFault.armed = false;
  outputFault.writes = 0;
  outputFault.hit = [];

  outputFault.seen = 0;
  outputFault.hitAt = 0;
  outputFault.failAtKind = null;
  outputFault.failAtOccurrence = 0;
  outputFault.code = 'ENOSPC';
  readFault.path = null;
  readFault.code = 'EACCES';
});

/** Runs an operation expected to reject and returns the error it rejected with. */
async function failureOf(run: () => Promise<unknown>, what: string): Promise<Error> {
  try {
    await run();
  } catch (err: unknown) {
    assert(err instanceof Error, `${what} must reject with an Error`);
    return err;
  }
  throw new Error(`${what} was expected to reject`);
}

describe('push and pull name the cache directory they cannot write the blob to', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let cacheDir: string;

  beforeEach(async () => {
    root = await mkTmp('bfs-cachewrite-root-');
    pdirs = [await mkTmp('bfs-cachewrite-a-'), await mkTmp('bfs-cachewrite-b-'), await mkTmp('bfs-cachewrite-c-')];
    io = createMockProviderIO({}, root, false).io;
    await init(root, {
      vault_name: 'cache-write',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      // Compression on: it routes the pack through the disk path
      // unconditionally, so the blob really is written to the cache directory
      // regardless of how small the fixture is.
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'data.txt'), 'z'.repeat(64 * 1024), 'utf-8');
    cacheDir = path.join(root, '.bfs', 'cache');
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should name the cache directory and `bfs config --cache-dir` when push cannot write the packed blob', async () => {
    await fs.mkdir(path.join(cacheDir, 'push.blob.pending'), { recursive: true });

    const failure = await failureOf(() => push(root, { io }), 'push');

    expect(failure, 'a refused cache write must arrive as a BfsError, not a raw system error').toBeInstanceOf(BfsError);
    expect(failure.message, 'the operator must be told which of the two volumes refused').toContain(cacheDir);
    expect(failure.message, 'the fix is one command and the error must say which').toContain(CACHE_DIR_HINT);
    // The cause is kept, exactly as the temp side keeps it: full, read-only and
    // permission-denied need different actions and only the errno tells them
    // apart. What must go is the bare errno standing alone, not the errno.
    expect(failure.message, "the operating system's reason must survive, as it does for the temp volume").toContain('EISDIR');
    const state = await readState(root);
    assert(state !== null, 'the fixture vault must have a state file');
    expect(state.latest_version, 'a push that never packed must record no version').toBe(0);
  });

  it('should name the cache directory and `bfs config --cache-dir` when pull cannot write the restored blob', async () => {
    const pushed = await push(root, { io });
    expect(pushed.version).toBe(1);
    await fs.mkdir(path.join(cacheDir, 'pull.blob.pending'), { recursive: true });

    const failure = await failureOf(() => pull(root, { io, force: true, yes: true }), 'pull');

    expect(failure, 'a refused cache write must arrive as a BfsError, not a raw system error').toBeInstanceOf(BfsError);
    expect(failure.message, 'the operator must be told which of the two volumes refused').toContain(cacheDir);
    expect(failure.message, 'the fix is one command and the error must say which').toContain(CACHE_DIR_HINT);
    expect(failure.message, "the operating system's reason must survive, as it does for the temp volume").toContain('EISDIR');
  });

  it('should name the cache directory when the uncompressed disk pack fills the volume mid-write', async () => {
    // The other route into the same directory. Compression off and a RAM budget
    // the blob cannot fit under send the pack down packBlobToFile, which copies
    // user files one at a time straight into the cache file. A refusal from that
    // handle is the destination refusing, and must be told apart from the file
    // that happened to be in hand when it did.
    const cfg = await readConfig(root);
    assert(cfg !== null, 'the fixture vault must have a config');
    await writeConfig(root, { ...cfg, compression: { enabled: false, algorithm: 'deflate' }, max_ram_mb: 1 });
    // The pack copies files in sorted order, so this is the one being read when
    // the second write - the first inside the copy loop - is refused. It is
    // therefore the name a destination fault must NOT come back wearing.
    const fileInHand = path.join(root, '.bfsignore');
    outputFault.armed = true;

    const failure = await failureOf(() => push(root, { io }), 'push with a full backup volume');

    expect(outputFault.hit, 'the fault must land on the blob being written into the cache').not.toHaveLength(0);
    expect(failure.message, 'the operator must be told which of the two volumes refused').toContain(cacheDir);
    expect(failure.message, 'the fix is one command and the error must say which').toContain(CACHE_DIR_HINT);
    expect(failure.message, "the operating system's reason must survive").toContain('ENOSPC');
    expect(failure.message, 'a refusal by the destination must not be reported against the file being read').not.toContain(fileInHand);
    expect(failure.message, 'the wording that blamed the source file must not come back').not.toMatch(/blob data for/i);
    const state = await readState(root);
    assert(state !== null, 'the fixture vault must have a state file');
    expect(state.latest_version, 'a push that never packed must record no version').toBe(0);
  });

  it('should still blame the temp directory, not the cache, when it is the scratch that refuses (A/B control)', async () => {
    // The opposite volume of the same push. This is what the cache message must
    // not swallow: two disks, two directories, two different one-command fixes.
    const tempFile = path.join(root, 'temp-is-a-file');
    await fs.writeFile(tempFile, 'not a directory', 'utf-8');

    const failure = await failureOf(() => push(root, { io, tempDir: tempFile }), 'push with a temp dir that is a file');

    expect(failure.message, 'a temp fault must keep naming the temp directory').toContain(tempFile);
    expect(failure.message, 'a temp fault must keep pointing at the temp-dir fix').toContain(TEMP_DIR_HINT);
    expect(failure.message, 'a temp fault must not be redirected at the backup volume').not.toContain(CACHE_DIR_HINT);
  });
});

describe('a restore that fails to decode is not reported as a cache write', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    root = await mkTmp('bfs-cachewrite-enc-root-');
    pdirs = [await mkTmp('bfs-cachewrite-enc-a-'), await mkTmp('bfs-cachewrite-enc-b-'), await mkTmp('bfs-cachewrite-enc-c-')];
    io = createMockProviderIO({}, root, false).io;
    await init(root, {
      vault_name: 'cache-write-enc',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'data.txt'), 'q'.repeat(16 * 1024), 'utf-8');
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should refuse a wrong password before the cache is ever written, and name the key (A/B control)', async () => {
    // Where this actually breaks matters, because it decides what the cache
    // message is allowed to swallow. A wrong password is caught in phase 1.5
    // (_validateShardIntegrity), which rethrows anything that is not a
    // ShardCorruptedError - so the restore stops before _decodeFromTempFiles
    // opens the blob file at all. The absence of that file below is the proof
    // of the ordering: a credential failure never reaches the write path, and
    // so must never come back wearing the cache volume's name.
    await push(root, { io, password: 'correct horse' });

    const failure = await failureOf(() => pull(root, { io, force: true, yes: true, password: 'wrong horse' }), 'pull with a wrong password');

    expect(failure.message, 'a credential failure must not be pinned on the cache directory').not.toContain(CACHE_DIR_HINT);
    // Wording read from the throw site (src/core/crypto.ts), not from memory.
    expect(failure.message, 'the operator must still learn the key is what failed').toContain('Decryption failed');
    const written = await fs
      .stat(path.join(root, '.bfs', 'cache', 'pull.blob.pending'))
      .then(() => true)
      .catch(() => false);
    expect(written, 'the restore must not have reached the cache write to fail this way').toBe(false);
  });
});

// The compressed pack is the default route into the cache directory, and it is
// the one that cannot tell the two directions of its per-file loop apart. The
// loop reads a user file and writes it into the ZIP under one `try`, so a
// refusal by the destination is filed as "this file was skipped" - wearing the
// name of the file that happened to be in hand. The uncompressed pack already
// separates them (packBlobToFile rethrows a BlobWriteError instead of skipping),
// and architecture/pipeline.md states that split as the contract; these tests
// hold the compressed pack to it.
//
// The fault is injected as a single refused write, not a permanently full
// volume, because only the transient shape reaches the damage: a volume that
// stays full also refuses finalize(), so the pack aborts and the operator is
// told the truth. One refusal that lets go leaves the pack to finish and seal a
// blob whose ZIP stream is missing a member.
//
// Both damaging shapes are staged, because they fail differently and a fix
// aimed at one would leave the other standing. Refusing a file's compressed
// bytes leaves a local header promising data that is not there, and the restore
// dies loudly. Refusing the local header itself leaves nothing at all - the
// stream stays structurally sound, the file table never mentions the file, and
// the restore SUCCEEDS while quietly short of it. The quiet one is the worse of
// the two and the reason a size filter alone was not enough.
describe('the compressed pack separates a refused cache write from an unreadable file', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let cacheDir: string;
  // Incompressible, so a file's deflate output stays far above the threshold
  // that tells compressed data apart from the two headers around it.
  const bodies = ['a.bin', 'b.bin', 'c.bin'];

  beforeEach(async () => {
    root = await mkTmp('bfs-zipwrite-root-');
    pdirs = [await mkTmp('bfs-zipwrite-a-'), await mkTmp('bfs-zipwrite-b-'), await mkTmp('bfs-zipwrite-c-')];
    io = createMockProviderIO({}, root, false).io;
    await init(root, {
      vault_name: 'zip-write',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    for (const name of bodies) {
      await fs.writeFile(path.join(root, name), randomBytes(8 * 1024));
    }
    cacheDir = path.join(root, '.bfs', 'cache');
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  /**
   * Arms one refused write of the given kind. `init` leaves a .bfsignore in the
   * root and it sorts ahead of the fixture files, so the second occurrence of a
   * kind belongs to a.bin and the third to b.bin.
   */
  function armRefusedWrite(kind: 'lfh' | 'data' | 'dd', occurrence: number, code = 'ENOSPC'): void {
    outputFault.armed = true;

    outputFault.failAtKind = kind;
    outputFault.failAtOccurrence = occurrence;
    outputFault.code = code;
  }

  /**
   * Restores the backup and reports both halves of the outcome: whether the
   * restore ran at all, and which fixture files came back. The two damaging
   * shapes fail on different halves - one dies inside the restore, the other
   * finishes and is simply short - so a check that only saw one of them would
   * miss the other.
   */
  async function restoreOutcome(): Promise<{ error: Nullable<Error>; names: string[] }> {
    for (const name of bodies) await fs.rm(path.join(root, name), { force: true });
    const error = await pull(root, { io, force: true, yes: true }).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    );
    const present: string[] = [];
    for (const name of bodies) {
      const there = await fs
        .stat(path.join(root, name))
        .then(() => true)
        .catch(() => false);
      if (there) present.push(name);
    }
    return { error, names: present };
  }

  it('should name the cache directory, not the file in hand, when a write inside the ZIP loop is refused', async () => {
    armRefusedWrite('data', 3);

    const failure = await failureOf(() => push(root, { io }), 'push whose cache write is refused mid-ZIP');

    expect(outputFault.hit, 'the fault must land on the blob being written into the cache').not.toHaveLength(0);
    expect(outputFault.hitAt, 'the refusal must land on the intended write, not an earlier one').toBe(3);
    // The heart of it: the destination refused, and the file being packed at
    // that moment is not at fault. Filing it as a skipped file sends the
    // operator to check a file that is perfectly readable, and says the one
    // thing that is certainly untrue - that it could not be read.
    expect(failure, 'a refused destination is not a source file that was skipped').not.toBeInstanceOf(PushSkippedError);
    expect(failure.message, 'a write that was refused must not be reported as a file that could not be read').not.toMatch(/could not be read/i);
    expect(failure.message, 'the operator must be told which of the two volumes refused').toContain(cacheDir);
    expect(failure.message, 'the fix is one command and the error must say which').toContain(CACHE_DIR_HINT);
    expect(failure.message, 'the reason the system gave must survive').toContain('ENOSPC');
  });

  it('should refuse a write it cannot tell apart by errno alone', async () => {
    // Same site, a refusal a full volume does not produce. A fix that sniffs
    // ENOSPC to decide which way the loop failed passes the test above and
    // fails here - the direction is a property of which handle refused, not of
    // the code it refused with. A read-only cache volume, a quota, a dying
    // mount: all arrive as something other than ENOSPC.
    armRefusedWrite('data', 3, 'EACCES');

    const failure = await failureOf(() => push(root, { io }), 'push whose cache write is refused with EACCES');

    expect(outputFault.hitAt, 'the refusal must land on the intended write, not an earlier one').toBe(3);
    expect(failure, 'a refused destination is not a source file that was skipped').not.toBeInstanceOf(PushSkippedError);
    expect(failure.message, 'the operator must be told which of the two volumes refused').toContain(cacheDir);
    expect(failure.message, 'the reason the system gave must survive').toContain('EACCES');
  });

  it('should not let a refused local header end as a backup that silently restores short', async () => {
    // The quiet shape. Nothing of the file reaches the stream, so the ZIP stays
    // readable and the restore reports success - just without the file. Only
    // comparing what went in against what came back catches it.
    armRefusedWrite('lfh', 3);
    await failureOf(() => push(root, { io }), 'push whose local-header write is refused');
    // Proof the fault reached the write it was aimed at, not merely some write:
    // the counter says how far it got, and it survives the fix, where the
    // refusal stops being reported against a user file at all.
    expect(outputFault.hitAt, 'the refusal must land on the intended write, not an earlier one').toBe(3);
    outputFault.armed = false;
    outputFault.failAtKind = null;

    const resumed = await push(root, { io, fromCache: true }).then(
      (r) => r as unknown,
      (e: unknown) => e,
    );
    if (resumed instanceof Error) {
      // Refusing the resume is an honest way out, but only for the right
      // reason: it has to be the cached data being unusable, not the upload
      // failing for reasons of its own.
      expect(resumed.message, 'a refused resume must say the cached data is what is wrong').toMatch(/cache/i);
      return;
    }

    const outcome = await restoreOutcome();

    expect(outcome.error, 'a version that was uploaded as complete must be restorable').toBeNull();
    expect(outcome.names, 'a backup that reported itself written must hold every file that was there').toEqual(bodies);
  });

  it('should not let a refused data write end as a backup that cannot be restored', async () => {
    armRefusedWrite('data', 3);
    await failureOf(() => push(root, { io }), 'push whose cache write is refused mid-ZIP');
    // Proof the fault reached the write it was aimed at, not merely some write:
    // the counter says how far it got, and it survives the fix, where the
    // refusal stops being reported against a user file at all.
    expect(outputFault.hitAt, 'the refusal must land on the intended write, not an earlier one').toBe(3);
    outputFault.armed = false;
    outputFault.failAtKind = null;

    // A refused write leaves two honest ways out: refuse the resume, or pack
    // again from scratch. The one thing that must not happen is uploading what
    // survived on disk - it is sealed with a checksum computed by re-reading the
    // file, so a ZIP that lost a member still passes its own seal check.
    const resumed = await push(root, { io, fromCache: true }).then(
      (r) => r as unknown,
      (e: unknown) => e,
    );
    if (resumed instanceof Error) {
      expect(resumed.message, 'a refused resume must say the cached data is what is wrong').toMatch(/cache/i);
      return;
    }

    const outcome = await restoreOutcome();

    expect(outcome.error, 'a version that was uploaded as complete must be restorable').toBeNull();
    expect(outcome.names, 'a backup that reported itself written must hold every file that was there').toEqual(bodies);
  });

  it('should still skip a file it cannot read, naming that file (A/B control)', async () => {
    // The opposite direction through the same loop, and the reason the fix has
    // to split them rather than rethrow everything: an unreadable source file
    // stays a skipped file, reported under its own name. The errno matches the
    // one used against the destination above, so nothing but the direction
    // itself can tell these two apart.
    readFault.path = path.join(root, 'b.bin');
    readFault.code = 'ENOSPC';

    const failure = await failureOf(() => push(root, { io }), 'push over an unreadable file');

    assert(failure instanceof PushSkippedError, 'an unreadable source file must still be reported as a skipped file');
    expect(
      failure.skipped.map((s) => s.path),
      'the skipped file must still be named, under its own name',
    ).toContain('b.bin');
    const reason = failure.skipped.find((s) => s.path === 'b.bin')?.reason ?? '';
    expect(reason, 'the reason kept for a skipped file must be the one the source gave').toContain('ENOSPC');
  });
});
