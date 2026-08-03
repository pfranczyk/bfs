import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LockConcurrentActiveError, LockPartialStatePushError } from '../../src/core/errors.js';
import { writeJsonAtomic } from '../../src/core/fs-utils.js';
import {
  acquireCachePushLock,
  acquirePushLock,
  acquireRepairLock,
  isLockLive,
  isLockStale,
  isPidAlive,
  LOCK_FORMAT_VERSION,
  LOCK_STALE_MS,
  type PushLock,
  pushLockPath,
  type RepairLock,
  readLock,
  removeLock,
  repairLockPath,
  writeLockAtomic,
} from '../../src/vault/lockfile.js';

function makePushLock(overrides: Partial<PushLock> = {}): PushLock {
  return {
    format_version: LOCK_FORMAT_VERSION,
    operation: 'push',
    version: 1,
    pid: process.pid,
    command: 'bfs push',
    started_at: new Date().toISOString(),
    scheme: { data_shards: 2, parity_shards: 1 },
    uploaded: [],
    failed: [],
    blob_pending_path: '.bfs/cache/push.blob.pending',
    ...overrides,
  };
}

function makeRepairLock(overrides: Partial<RepairLock> = {}): RepairLock {
  return {
    format_version: LOCK_FORMAT_VERSION,
    operation: 'repair',
    version_range: 'latest',
    pid: process.pid,
    command: 'bfs repair',
    started_at: new Date().toISOString(),
    succeeded_pairs: [],
    failed_pairs: [],
    failed_shards: [],
    ...overrides,
  };
}

describe('writeJsonAtomic', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should write a JSON file atomically with pretty-printed output', async () => {
    const filePath = path.join(tmpDir, 'lock.json');

    await writeJsonAtomic(filePath, { a: 1, b: [2, 3] });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ a: 1, b: [2, 3] });
    expect(content).toContain('\n');
  });

  it('should create parent directories when they do not exist', async () => {
    const filePath = path.join(tmpDir, 'nested', 'deep', 'lock.json');

    await writeJsonAtomic(filePath, { ok: true });

    expect(existsSync(filePath)).toBe(true);
  });

  it('should overwrite an existing destination file', async () => {
    const filePath = path.join(tmpDir, 'lock.json');
    await fs.writeFile(filePath, '{"old": true}', 'utf-8');

    await writeJsonAtomic(filePath, { new: true });

    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ new: true });
  });
});

describe('readLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-readlock-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return null when the lockfile does not exist', async () => {
    const filePath = path.join(tmpDir, 'push.lock');

    const result = await readLock(filePath);

    expect(result).toBeNull();
  });

  it('should parse and return the JSON payload when the file exists', async () => {
    const filePath = path.join(tmpDir, 'push.lock');
    const lock = makePushLock();
    await fs.writeFile(filePath, JSON.stringify(lock), 'utf-8');

    const result = await readLock<PushLock>(filePath);

    expect(result).toEqual(lock);
  });
});

describe('removeLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-removelock-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should delete an existing lockfile', async () => {
    const filePath = path.join(tmpDir, 'push.lock');
    await fs.writeFile(filePath, '{}', 'utf-8');

    await removeLock(filePath);

    expect(existsSync(filePath)).toBe(false);
  });

  it('should be a no-op when the lockfile does not exist', async () => {
    const filePath = path.join(tmpDir, 'push.lock');

    await expect(removeLock(filePath)).resolves.toBeUndefined();
  });
});

describe('isPidAlive', () => {
  it('should return true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('should return false for a non-existent PID', () => {
    // PID 0x7fffffff is the maximum signed 32-bit integer; vanishingly
    // unlikely to belong to a real process on the test machine.
    expect(isPidAlive(0x7fffffff)).toBe(false);
  });

  it('should return false for invalid PID values', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
  });
});

describe('isLockStale', () => {
  it('should return false for a fresh lock', () => {
    expect(isLockStale(new Date().toISOString())).toBe(false);
  });

  it('should return true for a lock older than LOCK_STALE_MS', () => {
    const old = new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString();
    expect(isLockStale(old)).toBe(true);
  });

  it('should return true for a malformed timestamp (pessimistic default)', () => {
    expect(isLockStale('not-a-date')).toBe(true);
  });
});

describe('isLockLive', () => {
  it('should return true for the current process with a fresh timestamp', () => {
    expect(isLockLive({ pid: process.pid, started_at: new Date().toISOString() })).toBe(true);
  });

  it('should return false when the process is dead', () => {
    expect(isLockLive({ pid: 0x7fffffff, started_at: new Date().toISOString() })).toBe(false);
  });

  it('should return false when the lock is stale even though the pid is alive', () => {
    const stale = new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString();
    expect(isLockLive({ pid: process.pid, started_at: stale })).toBe(false);
  });
});

describe('acquirePushLock — fresh push', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-acqpush-'));
    await fs.mkdir(path.join(tmpDir, '.bfs'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create push.lock with the current pid when the vault is clean', async () => {
    await acquirePushLock(tmpDir, makePushLock());

    const written = await readLock<PushLock>(pushLockPath(tmpDir));
    expect(written?.pid).toBe(process.pid);
  });

  it('should reject a later acquisition once a live lock is already held', async () => {
    await acquirePushLock(tmpDir, makePushLock());

    await expect(acquirePushLock(tmpDir, makePushLock())).rejects.toThrow(LockConcurrentActiveError);
  });

  // The core regression guard: two GENUINELY concurrent acquisitions race for the
  // same path. The exclusive create (O_EXCL) is the reservation, so exactly one
  // wins — a non-atomic read-then-write would let BOTH through (both read no lock,
  // both write) and corrupt version state. This is the test that goes RED on a
  // regression to non-atomic acquisition; the sequential case above would not.
  it('should admit exactly one of two concurrent acquisitions (TOCTOU race closed)', async () => {
    const results = await Promise.allSettled([acquirePushLock(tmpDir, makePushLock()), acquirePushLock(tmpDir, makePushLock())]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('should reject with ConcurrentActive when a live push.lock already exists', async () => {
    await writeLockAtomic(pushLockPath(tmpDir), makePushLock());

    await expect(acquirePushLock(tmpDir, makePushLock())).rejects.toThrow(LockConcurrentActiveError);
  });

  it('should reject with PartialState carrying the version when a dead push.lock leftover exists', async () => {
    const dead = makePushLock({ pid: 0x7fffffff, started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString(), version: 42 });
    await writeLockAtomic(pushLockPath(tmpDir), dead);

    const promise = acquirePushLock(tmpDir, makePushLock());

    await expect(promise).rejects.toThrow(LockPartialStatePushError);
    await expect(promise).rejects.toMatchObject({ version: 42 });
  });

  // A racing winner may have created the file but not finished writing its
  // JSON yet: an empty/torn read must classify as partial state, never crash.
  it('should treat an empty/torn push.lock as partial state', async () => {
    await fs.writeFile(pushLockPath(tmpDir), '', 'utf-8');

    await expect(acquirePushLock(tmpDir, makePushLock())).rejects.toThrow(LockPartialStatePushError);
  });

  it('should reject with ConcurrentActive when a live repair.lock exists', async () => {
    await writeLockAtomic(repairLockPath(tmpDir), makeRepairLock());

    await expect(acquirePushLock(tmpDir, makePushLock())).rejects.toThrow(LockConcurrentActiveError);
  });

  it('should reject with PartialState when a dead repair.lock leftover exists', async () => {
    const dead = makeRepairLock({ pid: 0x7fffffff, started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString() });
    await writeLockAtomic(repairLockPath(tmpDir), dead);

    await expect(acquirePushLock(tmpDir, makePushLock())).rejects.toThrow(LockPartialStatePushError);
  });
});

describe('acquireCachePushLock — push --cache resume', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-acqcache-'));
    await fs.mkdir(path.join(tmpDir, '.bfs'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should take over a dead push.lock leftover and write fresh content', async () => {
    const dead = makePushLock({ pid: 0x7fffffff, version: 7 });
    await writeLockAtomic(pushLockPath(tmpDir), dead);

    await acquireCachePushLock(tmpDir, makePushLock({ version: 8 }));

    const written = await readLock<PushLock>(pushLockPath(tmpDir));
    expect(written?.pid).toBe(process.pid);
    expect(written?.version).toBe(8);
  });

  it('should take over its own live lock (re-entrant resume of this process)', async () => {
    await writeLockAtomic(pushLockPath(tmpDir), makePushLock());

    await expect(acquireCachePushLock(tmpDir, makePushLock())).resolves.toBeUndefined();
  });

  // Previously --cache skipped the concurrency check entirely; now a live
  // repair blocks it.
  it('should reject when a live repair.lock is present', async () => {
    await writeLockAtomic(repairLockPath(tmpDir), makeRepairLock());

    await expect(acquireCachePushLock(tmpDir, makePushLock())).rejects.toThrow(LockConcurrentActiveError);
  });
});

describe('acquireRepairLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-acqrepair-'));
    await fs.mkdir(path.join(tmpDir, '.bfs'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create repair.lock with the current pid when the vault is clean', async () => {
    await acquireRepairLock(tmpDir, makeRepairLock());

    const written = await readLock<RepairLock>(repairLockPath(tmpDir));
    expect(written?.pid).toBe(process.pid);
  });

  it('should reject a later acquisition once a live lock is already held', async () => {
    await acquireRepairLock(tmpDir, makeRepairLock());

    await expect(acquireRepairLock(tmpDir, makeRepairLock())).rejects.toThrow(LockConcurrentActiveError);
  });

  // With no pre-existing lock, two concurrent repairs race for repair.lock and
  // the exclusive create admits exactly one. (Takeover of a *pre-existing* stale
  // lock under concurrency retains a narrow residual race — see decisions.md.)
  it('should admit exactly one of two concurrent acquisitions (TOCTOU race closed)', async () => {
    const results = await Promise.allSettled([acquireRepairLock(tmpDir, makeRepairLock()), acquireRepairLock(tmpDir, makeRepairLock())]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('should take over a stale repair.lock (idempotent retry)', async () => {
    const stale = makeRepairLock({ pid: 0x7fffffff, started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString() });
    await writeLockAtomic(repairLockPath(tmpDir), stale);

    await acquireRepairLock(tmpDir, makeRepairLock());

    const written = await readLock<RepairLock>(repairLockPath(tmpDir));
    expect(written?.pid).toBe(process.pid);
  });

  it('should reject when a live push.lock is present (first-to-start wins)', async () => {
    await writeLockAtomic(pushLockPath(tmpDir), makePushLock());

    await expect(acquireRepairLock(tmpDir, makeRepairLock())).rejects.toThrow(LockConcurrentActiveError);
  });

  it('should ignore a dead push.lock and proceed (repair recovers partial push state)', async () => {
    const dead = makePushLock({ pid: 0x7fffffff, started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString() });
    await writeLockAtomic(pushLockPath(tmpDir), dead);

    await acquireRepairLock(tmpDir, makeRepairLock());

    const written = await readLock<RepairLock>(repairLockPath(tmpDir));
    expect(written?.pid).toBe(process.pid);
  });
});
