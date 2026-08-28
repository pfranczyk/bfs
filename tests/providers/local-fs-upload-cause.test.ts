import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';

// The local adapter is the one place where the operating system's own error
// code reaches BFS. `ENOSPC` on the target of a rebuild is the difference
// between "the disk is full" and "something went wrong"; a ProviderError that
// flattens the error into a string loses the code, and with it any chance for
// the caller (today: the message; later: a reason) to say which.
const writeFault = vi.hoisted(() => ({ armed: false, hit: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createWriteStream = ((p: unknown, opts: unknown) => {
    if (writeFault.armed && typeof p === 'string' && /shard_\d+\.bfs\.\d+$/.test(p)) {
      writeFault.hit.push(p);
      return new Writable({
        write(_chunk, _encoding, callback) {
          const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device, write');
          err.code = 'ENOSPC';
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

describe('LocalFsProvider.upload keeps the operating-system error as the cause', () => {
  let dir: string;

  beforeEach(async () => {
    writeFault.armed = false;
    writeFault.hit = [];
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-localfs-cause-'));
  });

  afterEach(async () => {
    writeFault.armed = false;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('should carry ENOSPC from a failed write as ProviderError.cause', async () => {
    const provider = new LocalFsProvider({ id: 'disk', type: 'local', adapterPackage: null, config: { path: dir } }, createMockProviderIO().io);
    provider.setVaultName('vault');
    writeFault.armed = true;

    let failure: unknown = null;
    try {
      await provider.upload('shard_0.bfs.1', Readable.from(Buffer.alloc(4096, 1)), 4096);
    } catch (err: unknown) {
      failure = err;
    }

    expect(writeFault.hit, 'the fault must have hit the part being written').toHaveLength(1);
    expect(failure).toBeInstanceOf(ProviderError);
    assert(failure instanceof ProviderError);
    expect((failure.cause as NodeJS.ErrnoException | undefined)?.code, 'the errno must survive the wrapping').toBe('ENOSPC');
    expect(failure.message, 'the message still names the part').toContain('shard_0.bfs.1');
  });
});
