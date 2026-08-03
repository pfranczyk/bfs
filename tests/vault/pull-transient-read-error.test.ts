import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// A part that could not be read is not the same thing as a part that read back
// wrong. The first is a passing condition of the medium — a file briefly locked
// by an indexer or antivirus, a device that answered EBUSY/EPERM/EIO once — and
// the part is still whole; the second is damage. The restore has one moment
// where it reads a part solely to learn the size and salt the version was made
// with, and a fault there must not be allowed to condemn the medium: the same
// bytes are read again, independently, by the integrity pass that follows.
//
// The fault is armed for a single read of one temp file, so the second read of
// that same part succeeds — which is exactly what makes the medium's data
// demonstrably intact, and the accusation demonstrably wrong.
const readFault = vi.hoisted(() => ({ target: null as Nullable<{ basename: string }> }));

// Mocked at the module boundary because an ESM namespace export cannot be spied
// in place. Call-through by default; only an armed target faults, and it
// disarms itself after one stream, so every other read in the file is real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((p: unknown, opts: unknown) => {
    const target = readFault.target;
    if (target !== null && typeof p === 'string' && new RegExp(`[\\\\/]${target.basename}$`).test(p)) {
      readFault.target = null;
      const data = actual.readFileSync(p);
      // Everything but the last byte arrives, so the header parses and the
      // failure lands where the payload is being drained — then the medium
      // reports a transient I/O fault instead of ending the stream.
      return Readable.from(
        (async function* faulty() {
          yield data.subarray(0, data.length - 1);
          const err: NodeJS.ErrnoException = new Error('EIO: simulated transient read error');
          err.code = 'EIO';
          throw err;
        })(),
      );
    }
    return actual.createReadStream(p as never, opts as never);
  }) as typeof actual.createReadStream;
  const patched = { ...actual, createReadStream };
  return { ...patched, default: patched };
});

const VAULT_NAME = 'pull-transient';
const DIR_PREFIXES = ['bfs-pull-transient-alpha-', 'bfs-pull-transient-beta-', 'bfs-pull-transient-gamma-'] as const;

/** Payload large enough that one shard comfortably exceeds the header window. */
const FIXTURE_BYTES = 256 * 1024;

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
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

describe('pull survives a passing read fault on a sound medium', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let logs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;
  let fixture: string;

  async function setup(): Promise<void> {
    root = await mkTmp('bfs-pull-transient-root-');
    pdirs = [await mkTmp(DIR_PREFIXES[0]), await mkTmp(DIR_PREFIXES[1]), await mkTmp(DIR_PREFIXES[2])];
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    logs = mock.logs;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      // Uncompressed keeps the shard size predictable, well past the header window.
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    fixture = 'x'.repeat(FIXTURE_BYTES);
    await fs.writeFile(path.join(root, 'big.txt'), fixture, 'utf-8');
    await push(root, { io });
  }

  beforeEach(() => {
    root = '';
    pdirs = [];
    logs = [];
    fixture = '';
    readFault.target = null;
  });

  afterEach(async () => {
    readFault.target = null;
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should not condemn a medium whose part merely failed to read once', async () => {
    await setup();
    await fs.writeFile(path.join(root, 'big.txt'), 'clobbered', 'utf-8');
    readFault.target = { basename: 'shard_0' };
    const loggedBefore = logs.length;

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'big.txt'), 'utf-8')).toBe(fixture);
    const warnings = logs
      .slice(loggedBefore)
      .filter((l) => l.level === 'warn')
      .map((l) => l.message);
    // Every part is whole on its medium — the only thing that went wrong was one
    // read. Calling that damage sends the operator to repair sound data.
    expect(warnings.filter((m) => /damaged|integrity/i.test(m))).toEqual([]);
  });

  it('should still restore when a read fault lands on top of one genuinely lost part', async () => {
    // The pool can spare one part, and it has already spent that budget: p2's
    // part is really gone. A single failed read on p0 must not spend it twice
    // and take the whole restore down with it, because p0's bytes are there and
    // read back on the very next attempt.
    await setup();
    await fs.rm(shardPath(mediumDir(pdirs, 2), 2));
    await fs.writeFile(path.join(root, 'big.txt'), 'clobbered', 'utf-8');
    readFault.target = { basename: 'shard_0' };

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    expect(await fs.readFile(path.join(root, 'big.txt'), 'utf-8')).toBe(fixture);
  });
});
