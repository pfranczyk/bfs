import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { PushCacheCorruptedError } from '../../src/core/errors.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { init, push } from '../../src/vault/vault-manager.js';

// A resumed push is the one path that uploads bytes nobody just read from the
// source directory: they come from `.bfs/cache/push.blob.pending`, written by an
// earlier run. Between the two runs that file is an ordinary file on an ordinary
// disk - an interrupted write, bit-rot, or a scanner rewriting it all leave a
// cache whose content no longer matches the SHA-256 the blob carries at its end.
//
// Nothing downstream can catch it: every part gets sealed over the corrupt bytes,
// so each part verifies against itself, the manifest records the corrupt blob's
// own hash, and even `verify --deep` agrees. The mismatch only surfaces when the
// blob is finally unpacked, during a restore - the worst possible moment, and it
// blames the wrong layer. The blob seals itself, so the resume can compare before
// a single byte leaves the machine.

const VAULT_NAME = 'push-cache-integrity';
const CACHE_REL = path.join('.bfs', 'cache', 'push.blob.pending');
/** Header offsets of the data section in the BFS blob format. */
const OFF_DATA_SECTION_OFFSET = 0x36;
const OFF_DATA_SECTION_LENGTH = 0x3e;

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/**
 * Flips one byte inside the cached blob's data section, leaving the 70-byte
 * header and the trailing checksum untouched. The header is what tells the resume
 * path this is a blob at all: damage it instead and the file counts as one that
 * never finished being written, which the resume answers by packing the directory
 * again rather than refusing. Keeping it intact puts the cache in the case this
 * describes - a blob whose bytes no longer match the seal it carries.
 */
async function rotCacheData(cachePath: string): Promise<void> {
  const buf = await fs.readFile(cachePath);
  const start = Number(buf.readBigUInt64LE(OFF_DATA_SECTION_OFFSET));
  const length = Number(buf.readBigUInt64LE(OFF_DATA_SECTION_LENGTH));
  assert(length > 0, 'fixture blob must have a non-empty data section to rot');
  const pos = start + Math.floor(length / 2);
  const before = buf.readUInt8(pos);
  buf.writeUInt8(before ^ 0x01, pos);
  await fs.writeFile(cachePath, buf);
}

/**
 * Wraps an IO that treats any request for a secret as a failure. A resume must
 * establish that the cached bytes are sound before it asks the operator for
 * anything - a password prompt (and the Argon2 derivation behind it) spent on a
 * cache that is about to be rejected is work the operator cannot get back.
 */
function ioRefusingSecrets(base: ProviderIO): ProviderIO {
  return {
    ...base,
    askSecret: async () => {
      throw new Error('a secret was requested before the cached data was checked');
    },
  };
}

describe('push --cache checks the cached backup data against its own checksum', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;
  let ioLogs: Array<{ level: 'info' | 'debug' | 'warn'; message: string }>;

  /**
   * Leaves the vault exactly where an interrupted push leaves it: the version
   * degraded, the third medium unwritable, and the pending blob still on disk.
   * Compression is on (the default), so packing goes through the disk path and
   * writes the cache before uploading; a push that completes would then clear
   * it, which is why this fixture has to fail one upload to keep it.
   */
  async function partialPush(encrypted = false, password?: string): Promise<void> {
    root = await mkTmp('bfs-cache-integrity-root-');
    pdirs = [await mkTmp('bfs-cache-integrity-a-'), await mkTmp('bfs-cache-integrity-b-'), await mkTmp('bfs-cache-integrity-c-')];
    const mock = createMockProviderIO({}, root, false);
    io = mock.io;
    ioLogs = mock.logs;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: encrypted, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'the quick brown fox'.repeat(64), 'utf-8');

    // Replace the third medium's base directory with a regular file: upload()
    // then fails creating the vault subdirectory, so two of three parts land.
    const broken = pdirs[2];
    assert(broken !== undefined, 'fixture must have a third medium');
    await fs.rm(broken, { recursive: true, force: true });
    await fs.writeFile(broken, '', 'utf-8');

    const partial = await push(root, { io, ...(password !== undefined ? { password } : {}) });
    expect(partial.health).toBe(VersionHealth.Degraded);
    expect(await exists(path.join(root, CACHE_REL))).toBe(true);

    await fs.rm(broken, { force: true });
    await fs.mkdir(broken, { recursive: true });
  }

  /** Path of the part medium `pN` holds for the given version. */
  function shardPath(index: number, version: number): string {
    const dir = pdirs[index];
    assert(dir !== undefined, `fixture has no directory for medium p${index}`);
    return path.join(dir, VAULT_NAME, `shard_${index}.bfs.${version}`);
  }

  async function exists(file: string): Promise<boolean> {
    return fs
      .access(file)
      .then(() => true)
      .catch(() => false);
  }

  async function sha256OfFile(file: string): Promise<string> {
    return crypto
      .createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex');
  }

  beforeEach(() => {
    root = '';
    pdirs = [];
    ioLogs = [];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) {
      if (d) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('should refuse to resume from a cache whose bytes no longer match its checksum', async () => {
    await partialPush();
    await rotCacheData(path.join(root, CACHE_REL));

    await expect(push(root, { io, fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow(PushCacheCorruptedError);
    await expect(push(root, { io, fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow(/no longer matches its checksum/i);
  });

  it('should leave every part already on a medium byte-for-byte untouched', async () => {
    await partialPush();
    // Parts 0 and 1 landed during the partial push. An overwrite resume rewrites
    // them in place, so they - not the part that never arrived - are what proves
    // the refusal came before any byte was sent.
    const survivor = shardPath(0, 1);
    const before = await sha256OfFile(survivor);
    await rotCacheData(path.join(root, CACHE_REL));

    await expect(push(root, { io, fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow();

    expect(await sha256OfFile(survivor)).toBe(before);
    // The medium that missed the partial push must still be empty as well.
    expect(await exists(shardPath(2, 1))).toBe(false);
  });

  it('should name the cache file in the same breath as the mismatch, so the fault is not blamed on a medium', async () => {
    await partialPush();
    await rotCacheData(path.join(root, CACHE_REL));

    // One assertion over both facts: a refusal that names the file but not the
    // cause (or the reverse) sends the operator looking in the wrong place, and
    // an unrelated error that happens to quote the path would satisfy a split
    // assertion for free.
    await expect(push(root, { io, fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow(/no longer matches its checksum[\s\S]*push\.blob\.pending|push\.blob\.pending[\s\S]*no longer matches its checksum/i);
  });

  it('should refuse an encrypted backup without first asking for the password', async () => {
    const password = 'correct horse battery staple';
    await partialPush(true, password);
    await rotCacheData(path.join(root, CACHE_REL));

    // No password is supplied to the resume, so any code path that derives the
    // key before checking the cache has to prompt - and the prompt fails loudly.
    await expect(push(root, { io: ioRefusingSecrets(io), fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow(/no longer matches its checksum/i);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['a zeroed header, as an interrupted pack leaves behind', Buffer.alloc(256)],
    ['not backup data at all', Buffer.from('this is not a blob', 'utf-8')],
  ])('should pack the directory again when the cache is %s', async (_label, content) => {
    await partialPush();
    // The header is written LAST, so a pack cut short leaves a file that never
    // became a blob. That is unfinished work, not damage: it healed itself by
    // re-packing before the seal check existed, and must keep doing so - the
    // refusal is for a real blob whose bytes stopped matching it.
    await fs.writeFile(path.join(root, CACHE_REL), content);

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    expect(await exists(shardPath(2, 1))).toBe(true);
  });

  it('should still resume from an intact cache', async () => {
    await partialPush();

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    expect(await exists(shardPath(2, 1))).toBe(true);
  });

  // The seal check walks the whole cache, and a resume exists for backups too
  // big to push in one go - so the wait is longest exactly here. It has to say
  // what it is doing, and say it before the read rather than after.
  it('should announce the checksum check before claiming the cache is in use', async () => {
    await partialPush();
    ioLogs.length = 0;

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    const said = ioLogs.filter((l) => l.level === 'info').map((l) => l.message);
    const checking = said.findIndex((m) => /checking cached backup data/i.test(m));
    const using = said.findIndex((m) => /using cached backup data/i.test(m));
    expect(checking).toBeGreaterThanOrEqual(0);
    expect(using).toBeGreaterThan(checking);
  });

  // Ordering alone does not pin "before the read": the line moved past the
  // comparison would still land before "using...". A cache that fails the
  // comparison never reaches "using..." at all, so an announcement surviving here
  // can only have been made while the file was still being read.
  it('should have announced the check by the time a damaged cache is refused', async () => {
    await partialPush();
    await rotCacheData(path.join(root, CACHE_REL));
    ioLogs.length = 0;

    await expect(push(root, { io, fromCache: true, mode: PushMode.Overwrite })).rejects.toThrow(PushCacheCorruptedError);

    expect(ioLogs.some((l) => /checking cached backup data/i.test(l.message))).toBe(true);
  });

  // A cache that never became a blob is answered by re-packing, so announcing a
  // checksum check there would be followed by "no cached backup data found".
  it('should stay silent about the checksum check when the cache never became a blob', async () => {
    await partialPush();
    await fs.writeFile(path.join(root, CACHE_REL), Buffer.alloc(256));
    ioLogs.length = 0;

    await push(root, { io, fromCache: true, mode: PushMode.Overwrite });

    expect(ioLogs.some((l) => /checking cached backup data/i.test(l.message))).toBe(false);
    expect(ioLogs.some((l) => /no cached backup data found/i.test(l.message))).toBe(true);
  });
});
