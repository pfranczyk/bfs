import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { t } from '../../src/i18n/index.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// A part that could not be written to the local scratch directory (the system
// temp is full - tmpfs smaller than blobSize x (N+K)/N is the textbook case)
// is a very different thing from a part the medium could not deliver. The
// first is a local condition with a one-command fix (`bfs config --temp-dir`);
// the second is a medium to reconnect or repair. Both failures reject the same
// download step, and a restore that reports the first as the second sends the
// operator to `bfs verify --deep`, which will show every medium healthy.
//
// The fault is a write stream that fails with ENOSPC for the scratch parts
// listed in `indices`, so the parts before them land and each listed one hits
// the "full volume" the way a real one does. The armed regex matches only the
// restore's own scratch files, so every other write in the process is real.
const writeFault = vi.hoisted(() => ({ armed: false, code: 'ENOSPC', indices: [1, 2] as number[], hit: [] as string[] }));

// Mocked at the module boundary because an ESM namespace export cannot be spied
// in place. Call-through by default; only an armed fault intercepts, and only
// for the scratch parts of a pull.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((p: unknown, opts: unknown) => {
    const part = typeof p === 'string' ? /bfs-pull-[^\\/]+[\\/]shard_(\d+)$/.exec(p) : null;
    if (writeFault.armed && part !== null && writeFault.indices.includes(Number(part[1]))) {
      writeFault.hit.push(part[0]);
      return new Writable({
        write(_chunk, _encoding, callback) {
          const err: NodeJS.ErrnoException = new Error(`${writeFault.code}: simulated scratch write fault, write`);
          err.code = writeFault.code;
          err.syscall = 'write';
          callback(err);
        },
      });
    }
    return actual.createWriteStream(p as never, opts as never);
  }) as typeof actual.createWriteStream;
  const patched = { ...actual, createWriteStream };
  return { ...patched, default: patched };
});

const VAULT_NAME = 'pull-scratch';
const MEDIA = ['medium-alpha', 'medium-beta', 'medium-gamma'] as const;
const TEMP_DIR_HINT = 'bfs config --temp-dir';

/** Payload large enough that every part is written in more than one chunk. */
const FIXTURE_BYTES = 256 * 1024;

// Fixture prefixes deliberately do not start with `bfs-pull-`: the tests find
// the restore's own scratch directory by that prefix, and a fixture sharing it
// would be mistaken for the scratch.
async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/**
 * Records every directory `fs.mkdtemp` hands out, so the test knows the path of
 * the restore's scratch directory and can check what the error names.
 */
function trackMkdtemp(onCreated?: (dir: string) => Promise<void>): string[] {
  const created: string[] = [];
  const original = fs.mkdtemp;
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
    const dir = await original(prefix as string, options as never);
    created.push(String(dir));
    if (onCreated) await onCreated(String(dir));
    return dir as never;
  });
  return created;
}

/** A medium stream that delivers part of the file and then fails with `code`. */
function faultyRead(filePath: string, code: string): Readable {
  return Readable.from(
    (async function* faulty() {
      const data = await fs.readFile(filePath);
      yield data.subarray(0, Math.floor(data.length / 2));
      const err: NodeJS.ErrnoException = new Error(`${code}: simulated read fault, read`);
      err.code = code;
      err.syscall = 'read';
      throw err;
    })(),
  );
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** Runs pull and returns the error it rejects with. */
async function pullFailure(root: string, io: ProviderIO): Promise<Error> {
  try {
    await pull(root, { io, force: true });
  } catch (err: unknown) {
    assert(err instanceof Error, 'pull must reject with an Error');
    return err;
  }
  throw new Error('pull was expected to reject');
}

describe('pull names a scratch directory it cannot write to, instead of blaming the media', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;

  beforeEach(async () => {
    writeFault.armed = false;
    writeFault.code = 'ENOSPC';
    writeFault.indices = [1, 2];
    writeFault.hit = [];
    root = await mkTmp('bfs-scratchtest-root-');
    pdirs = [await mkTmp('bfs-scratchtest-a-'), await mkTmp('bfs-scratchtest-b-'), await mkTmp('bfs-scratchtest-c-')];
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    logs = mock.logs;
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(MEDIA[i] ?? `p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(FIXTURE_BYTES), 'utf-8');
    await push(root, { io });
    logs.length = 0;
  });

  afterEach(async () => {
    writeFault.armed = false;
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  /** Asserts the error blames the scratch, and not a single medium. */
  function expectScratchBlamed(err: Error, scratchPath: string): void {
    expect(err).toBeInstanceOf(BfsError);
    expect(err.message, 'the error must name the scratch location that refused the write').toContain(scratchPath);
    expect(err.message, 'the fix is one command and the error must say which').toContain(TEMP_DIR_HINT);
    // No medium lost anything: their parts are whole, and saying otherwise sends
    // the operator to `bfs verify --deep`, which will find every medium healthy.
    // That advice is a dead end here and must go, not just gain a neighbour.
    expect(err.message, 'a check of the media is not the way out of a full temp').not.toContain('bfs verify --deep');
    for (const id of MEDIA) {
      expect(err.message, `medium ${id} must not be blamed for a scratch failure`).not.toContain(id);
    }
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(
      warnings.filter((m) => MEDIA.some((id) => m.includes(id))),
      'no warning may report backup data missing on a medium',
    ).toEqual([]);
  }

  /** Asserts the error blames the media that failed, and never the scratch. */
  function expectMediaBlamed(err: Error, scratchDir: string): void {
    expect(err).toBeInstanceOf(BfsError);
    expect(err.message, 'the media whose parts did not arrive must be named').toContain('medium-beta');
    expect(err.message).toContain('medium-gamma');
    expect(err.message, 'a medium failure must not be pinned on the scratch directory').not.toContain(TEMP_DIR_HINT);
    expect(err.message).not.toContain(scratchDir);
  }

  // Two errnos on the write side as well: ENOSPC is what a full volume says,
  // EPERM is what a scanner holding the file says - and EPERM is also one of
  // the errnos the read-side controls below use. Whatever the errno, a failure
  // of the scratch is the scratch's; the side, not the code, decides.
  for (const code of ['ENOSPC', 'EPERM'] as const) {
    it(`should abort with the scratch directory and \`bfs config --temp-dir\` when a scratch part fails with ${code}`, async () => {
      const created = trackMkdtemp();
      writeFault.armed = true;
      writeFault.code = code;

      const err = await pullFailure(root, io);

      // The fault must have fired where the restore writes its parts - otherwise
      // this test would be judging a restore that never met a full volume.
      expect(writeFault.hit.length, `the ${code} fault must hit a scratch part`).toBeGreaterThan(0);
      const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
      assert(scratchDir !== undefined, 'pull must create its bfs-pull-* scratch directory');
      expectScratchBlamed(err, scratchDir);
      expect(await exists(scratchDir), 'scratch dir must be removed after the failed pull').toBe(false);
    });
  }

  it('should name both the scratch and the medium that really failed when the two coincide below N', async () => {
    // Field reality is rarely one cause at a time: the temp fills up while one
    // medium is genuinely offline. Telling the sides apart means naming each
    // for what it did - the scratch with its fix, the failed medium by name -
    // and leaving the medium whose part merely did not fit out of it.
    const created = trackMkdtemp();
    writeFault.armed = true;
    writeFault.indices = [1];
    const origDownload = LocalFsProvider.prototype.download;
    vi.spyOn(LocalFsProvider.prototype, 'download').mockImplementation(async function (this: LocalFsProvider, ref) {
      if (!/shard_2\.bfs\.\d+$/.test(ref.path)) return origDownload.call(this, ref);
      const err: NodeJS.ErrnoException = new Error('EIO: i/o error, open');
      err.code = 'EIO';
      throw err;
    });

    const err = await pullFailure(root, io);

    expect(writeFault.hit, 'the scratch fault must hit part 1').toHaveLength(1);
    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
    assert(scratchDir !== undefined);
    expect(err).toBeInstanceOf(BfsError);
    expect(err.message, 'the scratch must be named with its fix').toContain(scratchDir);
    expect(err.message).toContain(TEMP_DIR_HINT);
    expect(err.message, 'the medium that really failed must be named').toContain('medium-gamma');
    expect(err.message, 'the medium whose part only did not fit in the temp is healthy').not.toContain('medium-beta');
  });

  it('should abort naming the scratch directory when a scratch part cannot even be created (real condition, no stream mock)', async () => {
    // No mocked stream here: the scratch directory is real and the name the
    // restore wants for its part is already taken by a directory, so opening it
    // for writing fails inside the operating system. Whatever errno that is on
    // this platform, it is the scratch that refused - not any medium.
    const created = trackMkdtemp(async (dir) => {
      if (!path.basename(dir).startsWith('bfs-pull-')) return;
      await fs.mkdir(path.join(dir, 'shard_1'));
      await fs.mkdir(path.join(dir, 'shard_2'));
    });

    const err = await pullFailure(root, io);

    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
    assert(scratchDir !== undefined);
    expectScratchBlamed(err, scratchDir);
    expect(await exists(scratchDir), 'scratch dir must be removed after the failed pull').toBe(false);
  });

  it('should still restore when N parts fit in the scratch and only a redundant one does not, naming the scratch and no medium', async () => {
    // The temp holds exactly N parts. The restore can finish from those, and
    // must: a full temp is a nuisance to report, not a reason to refuse files
    // that are one decode away. What it reports has to be the temp - the
    // medium whose part did not fit is healthy, so neither a "missing on
    // medium" notice nor the "pool degraded, run `bfs push`" advice may appear.
    const created = trackMkdtemp();
    await fs.writeFile(path.join(root, 'big.txt'), 'clobbered', 'utf-8');
    writeFault.armed = true;
    writeFault.indices = [2];

    const result = await pull(root, { io, force: true });

    expect(writeFault.hit, 'the ENOSPC fault must hit the redundant part').toHaveLength(1);
    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'big.txt'), 'utf-8')).toBe('x'.repeat(FIXTURE_BYTES));
    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
    assert(scratchDir !== undefined);
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(
      warnings.some((m) => m.includes(scratchDir) && m.includes(TEMP_DIR_HINT)),
      `a warning must name the scratch and the fix, got:\n${warnings.join('\n')}`,
    ).toBe(true);
    expect(
      warnings.filter((m) => MEDIA.some((id) => m.includes(id))),
      'no medium may be reported as missing backup data',
    ).toEqual([]);
    expect(warnings, 'the pool is not degraded - every medium still holds its part').not.toContain(t('vault_degraded_file_missing'));
  });

  it('should keep fetching the remaining parts after the FIRST part fails to land in the scratch (positional control)', async () => {
    // The part that does not fit is the first one requested. A restore that
    // gave up at the first scratch failure would leave itself one part short
    // here, while the two parts that would have fit are still on their media -
    // so this is the case that tells "carry on" from "stop at the first".
    const created = trackMkdtemp();
    await fs.writeFile(path.join(root, 'big.txt'), 'clobbered', 'utf-8');
    writeFault.armed = true;
    writeFault.indices = [0];

    const result = await pull(root, { io, force: true });

    expect(writeFault.hit, 'the scratch fault must hit the first part').toHaveLength(1);
    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'big.txt'), 'utf-8')).toBe('x'.repeat(FIXTURE_BYTES));
    const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
    assert(scratchDir !== undefined);
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(
      warnings.some((m) => m.includes(scratchDir) && m.includes(TEMP_DIR_HINT)),
      `a warning must name the scratch and the fix, got:\n${warnings.join('\n')}`,
    ).toBe(true);
    expect(
      warnings.filter((m) => MEDIA.some((id) => m.includes(id))),
      'no medium may be reported as missing backup data',
    ).toEqual([]);
  });

  it('should name the temp directory and `bfs config --temp-dir` when the scratch directory itself cannot be created', async () => {
    // A full temp volume refuses the scratch directory before any part is
    // written. That failure has nothing to do with the media either, and must
    // not reach the operator as a raw errno from mkdtemp.
    const original = fs.mkdtemp;
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
      if (String(prefix).endsWith('bfs-pull-')) {
        const err: NodeJS.ErrnoException = new Error(`ENOSPC: no space left on device, mkdtemp '${String(prefix)}XXXXXX'`);
        err.code = 'ENOSPC';
        err.syscall = 'mkdtemp';
        throw err;
      }
      return original(prefix as string, options as never) as never;
    });
    const download = vi.spyOn(LocalFsProvider.prototype, 'download');

    const err = await pullFailure(root, io);

    expectScratchBlamed(err, path.resolve(os.tmpdir()));
    expect(download, 'no part may be fetched when there is nowhere to put it').not.toHaveBeenCalled();
  });

  // Opposite side, same fixture: the scratch is fine, the media stop answering
  // mid-transfer. The restore must keep naming the media here - this is what
  // proves the verdicts above come from telling the sides apart, not from a
  // blanket relabelling of every download failure.
  //
  // Three shapes on purpose. EIO mid-transfer is a medium's own kind of
  // failure; EPERM mid-transfer is one a scratch volume can raise as well (and
  // one a medium raises when a scanner briefly holds a part), so a restore that
  // sorted failures by errno alone would pin it on the temp directory; and a
  // raw EACCES from `open` at the moment the part is requested is what an
  // adapter that does not wrap its stream errors hands over, so sorting by
  // syscall would misfile that one. Each must still name the medium, never
  // `bfs config --temp-dir`, where nothing is wrong.
  const readSideFaults: Array<{ label: string; download: (partPath: string) => Promise<Readable> }> = [
    { label: 'EIO mid-transfer', download: async (partPath) => faultyRead(partPath, 'EIO') },
    { label: 'EPERM mid-transfer', download: async (partPath) => faultyRead(partPath, 'EPERM') },
    {
      label: 'EACCES from open, before any byte',
      download: async () => {
        const err: NodeJS.ErrnoException = new Error('EACCES: permission denied, open');
        err.code = 'EACCES';
        err.syscall = 'open';
        throw err;
      },
    },
  ];
  for (const { label, download } of readSideFaults) {
    it(`should still blame the medium when the failure is on the read side: ${label} (A/B control)`, async () => {
      const created = trackMkdtemp();
      const origDownload = LocalFsProvider.prototype.download;
      vi.spyOn(LocalFsProvider.prototype, 'download').mockImplementation(async function (this: LocalFsProvider, ref) {
        const m = /shard_([12])\.bfs\.\d+$/.exec(ref.path);
        if (!m) return origDownload.call(this, ref);
        const dir = pdirs[Number(m[1])];
        assert(dir !== undefined);
        return download(path.join(dir, VAULT_NAME, path.basename(ref.path)));
      });

      const err = await pullFailure(root, io);

      expect(writeFault.hit, 'no scratch fault is armed in the control').toEqual([]);
      const scratchDir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
      assert(scratchDir !== undefined);
      expectMediaBlamed(err, scratchDir);
    });
  }
});
