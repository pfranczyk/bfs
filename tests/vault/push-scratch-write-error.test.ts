import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readState } from '../../src/vault/state.js';
import { init, push } from '../../src/vault/vault-manager.js';

// Push writes its parity parts into a private bfs-push-* scratch directory
// under the system temp before any medium is touched. When that volume is full
// the operator has two candidates for "which disk ran out" - the one holding
// the backup and the one holding the temp - and the raw ENOSPC from a file
// descriptor names neither. The push must say which directory it could not
// write and how to move it (`bfs config --temp-dir`).
//
// The fault is a parity file handle whose write fails with ENOSPC; the open
// itself succeeds, so the failure lands mid-encode the way a full volume does.
// Only the push's own parity files are intercepted; every other open is real.
const parityFault = vi.hoisted(() => ({ armed: false, hit: [] as string[] }));

// The opposite side of the same encode: the blob being read, not the parity
// being written. A resumed push (`--cache`) reads its blob from the backup's
// own cache directory - the volume holding the backup, not the temp. The fault
// is armed only once the scratch directory exists, which is the moment the
// encode opens the blob, so the cache verification that runs earlier reads the
// real file.
const sourceFault = vi.hoisted(() => ({ armed: false, scratchSeen: false, hit: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (p: unknown, flags: unknown, mode: unknown) => {
    const handle = await actual.open(p as never, flags as never, mode as never);
    if (parityFault.armed && typeof p === 'string' && /bfs-push-[^\\/]+[\\/]parity-\d+-\d+\.tmp$/.test(p)) {
      parityFault.hit.push(p);
      const write = async () => {
        const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        err.syscall = 'write';
        throw err;
      };
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'write') return write;
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }
    return handle;
  }) as typeof actual.open;
  const patched = { ...actual, open };
  return { ...patched, default: patched };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((p: unknown, opts: unknown) => {
    if (sourceFault.armed && sourceFault.scratchSeen && typeof p === 'string' && /push\.blob\.pending$/.test(p)) {
      sourceFault.hit.push(p);
      return Readable.from(
        (async function* broken() {
          yield Buffer.alloc(1024, 1);
          const err: NodeJS.ErrnoException = new Error('EIO: i/o error, read');
          err.code = 'EIO';
          err.syscall = 'read';
          throw err;
        })(),
      );
    }
    return actual.createReadStream(p as never, opts as never);
  }) as typeof actual.createReadStream;
  const patched = { ...actual, createReadStream };
  return { ...patched, default: patched };
});

const TEMP_DIR_HINT = 'bfs config --temp-dir';

// Fixture prefixes deliberately do not start with `bfs-push-`: the tests find
// the push's own scratch directory by that prefix, and a fixture sharing it
// would be mistaken for the scratch.
async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** Records every directory `fs.mkdtemp` hands out during the test. */
function trackMkdtemp(): string[] {
  const created: string[] = [];
  const original = fs.mkdtemp;
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
    const dir = await original(prefix as string, options as never);
    created.push(String(dir));
    if (path.basename(String(dir)).startsWith('bfs-push-')) sourceFault.scratchSeen = true;
    return dir as never;
  });
  return created;
}

/** Runs push and returns the error it rejects with. */
async function pushFailure(root: string, io: ProviderIO, fromCache = false): Promise<Error> {
  try {
    await push(root, { io, fromCache });
  } catch (err: unknown) {
    assert(err instanceof Error, 'push must reject with an Error');
    return err;
  }
  throw new Error('push was expected to reject');
}

describe('push names a scratch directory it cannot write parity parts to', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    parityFault.armed = false;
    parityFault.hit = [];
    sourceFault.armed = false;
    sourceFault.scratchSeen = false;
    sourceFault.hit = [];
    root = await mkTmp('bfs-scratchtest-push-root-');
    pdirs = [await mkTmp('bfs-scratchtest-push-a-'), await mkTmp('bfs-scratchtest-push-b-'), await mkTmp('bfs-scratchtest-push-c-')];
    io = createMockProviderIO({}, root, false).io;
    await init(root, {
      vault_name: 'push-scratch',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'big.txt'), 'y'.repeat(256 * 1024), 'utf-8');
  });

  afterEach(async () => {
    parityFault.armed = false;
    sourceFault.armed = false;
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should abort before any upload, naming the scratch directory and `bfs config --temp-dir`, when a parity write fails with ENOSPC', async () => {
    const created = trackMkdtemp();
    const rmSpy = vi.spyOn(fs, 'rm');
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');
    parityFault.armed = true;

    const failure = await pushFailure(root, io);

    expect(parityFault.hit, 'the ENOSPC fault must hit the parity part of this push').toHaveLength(1);
    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-push-'));
    assert(scratchDir !== undefined, 'push must create its bfs-push-* scratch directory');

    expect(failure).toBeInstanceOf(BfsError);
    expect(failure.message, 'the error must name the scratch directory that is full').toContain(scratchDir);
    expect(failure.message, 'the fix is one command and the error must say which').toContain(TEMP_DIR_HINT);
    expect(upload, 'a push that could not encode must not touch any medium').not.toHaveBeenCalled();
    const state = await readState(root);
    assert(state !== null, 'the fixture vault must have a state file');
    expect(state.latest_version, 'no version may be recorded').toBe(0);
    expect(await exists(scratchDir), 'scratch dir must be removed after the failed push').toBe(false);
    // The advice is "fix the temp dir and push again". Nothing reached a
    // medium and the backup data lived in RAM, so there is no partial state to
    // keep - a leftover push.lock would turn that advice into `bfs clear` first.
    expect(await exists(path.join(root, '.bfs', 'push.lock')), 'no lock may be left when nothing was uploaded and nothing cached').toBe(false);
    parityFault.armed = false;
    const retried = await push(root, { io });
    expect(retried.version, 'the advised retry must go through').toBe(1);
    // Removal of a directory the OS may still be holding (antivirus, indexer)
    // has to retry, like scripts/clean-temp.ts does, or the parity parts stay.
    const scratchRemovals = rmSpy.mock.calls.filter(([p]) => String(p) === scratchDir);
    expect(scratchRemovals.length).toBeGreaterThan(0);
    for (const [, options] of scratchRemovals) {
      expect(options).toEqual(expect.objectContaining({ recursive: true, force: true, maxRetries: 3 }));
    }
  });

  it('should name the temp directory and `bfs config --temp-dir` when the scratch directory itself cannot be created', async () => {
    // A full temp volume refuses the scratch directory before a single parity
    // byte is written; that must not reach the operator as a raw errno either.
    const original = fs.mkdtemp;
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
      if (String(prefix).endsWith('bfs-push-')) {
        const err: NodeJS.ErrnoException = new Error(`ENOSPC: no space left on device, mkdtemp '${String(prefix)}XXXXXX'`);
        err.code = 'ENOSPC';
        err.syscall = 'mkdtemp';
        throw err;
      }
      return original(prefix as string, options as never) as never;
    });
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');

    const failure = await pushFailure(root, io);

    expect(failure).toBeInstanceOf(BfsError);
    expect(failure.message, 'the error must name the temp directory that refused the scratch').toContain(path.resolve(os.tmpdir()));
    expect(failure.message).toContain(TEMP_DIR_HINT);
    expect(upload, 'a push with nowhere to encode must not touch any medium').not.toHaveBeenCalled();
  });

  it('should not blame the scratch directory when it is the cached blob that cannot be read (A/B control)', async () => {
    // Same encode, opposite side: the parity files are fine, the blob read
    // from the backup's own cache stops mid-way. That is the backup's volume,
    // not the temp, and an error sending the operator to `bfs config --temp-dir`
    // would name the wrong disk - the exact confusion this behaviour exists to
    // remove. The cache is produced the way a real one is: by a push whose
    // uploads all failed.
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload').mockRejectedValue(new Error('media offline'));
    await expect(push(root, { io })).rejects.toThrow(BfsError);
    upload.mockRestore();
    const cachePath = path.join(root, '.bfs', 'cache', 'push.blob.pending');
    expect(await exists(cachePath), 'the failed push must leave the blob in the cache').toBe(true);
    const created = trackMkdtemp();
    sourceFault.armed = true;

    const failure = await pushFailure(root, io, true);

    expect(sourceFault.hit, 'the read fault must hit the cached blob during the encode').toHaveLength(1);
    expect(parityFault.hit, 'no parity fault is armed in the control').toEqual([]);
    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-push-'));
    assert(scratchDir !== undefined, 'the encode must have reached the scratch directory');
    expect(failure.message, 'a broken blob source must not be pinned on the scratch directory').not.toContain(scratchDir);
    expect(failure.message).not.toContain(TEMP_DIR_HINT);
    expect(failure.message, 'the cause the operator gets must be the read failure').toContain('EIO');
    expect(await exists(scratchDir), 'scratch dir must be removed after the failed push').toBe(false);
    // A resume keeps what it resumes from: the cached blob is still there for
    // the next `--cache`, so its lock must survive this failure.
    expect(await exists(path.join(root, '.bfs', 'push.lock')), 'a failed resume must keep its lock for the next --cache').toBe(true);
    expect(await exists(cachePath), 'a failed resume must keep the cached blob').toBe(true);
  });
});
