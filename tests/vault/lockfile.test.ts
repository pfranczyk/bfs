import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LockConcurrentActiveError,
  LockPartialStatePushError,
} from '../../src/core/errors.js';
import { writeJsonAtomic } from '../../src/core/fs-utils.js';
import {
  assertNoActiveLock,
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

describe('assertNoActiveLock — push operation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-asserta-push-'));
    await fs.mkdir(path.join(tmpDir, '.bfs'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should pass when no lockfile exists', async () => {
    await expect(assertNoActiveLock(tmpDir, 'push')).resolves.toBeUndefined();
  });

  it('should throw LockConcurrentActiveError when a live push.lock exists', async () => {
    await writeLockAtomic(pushLockPath(tmpDir), makePushLock());

    await expect(assertNoActiveLock(tmpDir, 'push')).rejects.toThrow(
      LockConcurrentActiveError,
    );
  });

  it('should throw LockPartialStatePushError when a stale push.lock exists', async () => {
    const stale = makePushLock({
      pid: 0x7fffffff,
      started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString(),
      version: 42,
    });
    await writeLockAtomic(pushLockPath(tmpDir), stale);

    const promise = assertNoActiveLock(tmpDir, 'push');

    await expect(promise).rejects.toThrow(LockPartialStatePushError);
    await expect(promise).rejects.toMatchObject({ version: 42 });
  });

  it('should throw LockConcurrentActiveError when a live repair.lock exists', async () => {
    await writeLockAtomic(repairLockPath(tmpDir), makeRepairLock());

    await expect(assertNoActiveLock(tmpDir, 'push')).rejects.toThrow(
      LockConcurrentActiveError,
    );
  });

  it('should throw LockPartialStatePushError when a stale repair.lock exists', async () => {
    const stale = makeRepairLock({
      pid: 0x7fffffff,
      started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString(),
    });
    await writeLockAtomic(repairLockPath(tmpDir), stale);

    await expect(assertNoActiveLock(tmpDir, 'push')).rejects.toThrow(
      LockPartialStatePushError,
    );
  });
});

describe('assertNoActiveLock — repair operation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-asserta-repair-'));
    await fs.mkdir(path.join(tmpDir, '.bfs'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should pass when no lockfile exists', async () => {
    await expect(assertNoActiveLock(tmpDir, 'repair')).resolves.toBeUndefined();
  });

  it('should throw LockConcurrentActiveError when a live repair.lock exists', async () => {
    await writeLockAtomic(repairLockPath(tmpDir), makeRepairLock());

    await expect(assertNoActiveLock(tmpDir, 'repair')).rejects.toThrow(
      LockConcurrentActiveError,
    );
  });

  it('should pass when a stale repair.lock exists (idempotent retry semantics)', async () => {
    const stale = makeRepairLock({
      pid: 0x7fffffff,
      started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString(),
    });
    await writeLockAtomic(repairLockPath(tmpDir), stale);

    await expect(assertNoActiveLock(tmpDir, 'repair')).resolves.toBeUndefined();
  });

  it('should pass when a live push.lock exists (repair cleans up after push)', async () => {
    await writeLockAtomic(pushLockPath(tmpDir), makePushLock());

    await expect(assertNoActiveLock(tmpDir, 'repair')).resolves.toBeUndefined();
  });

  it('should pass when a stale push.lock exists (repair cleans up after push)', async () => {
    const stale = makePushLock({
      pid: 0x7fffffff,
      started_at: new Date(Date.now() - (LOCK_STALE_MS + 1000)).toISOString(),
    });
    await writeLockAtomic(pushLockPath(tmpDir), stale);

    await expect(assertNoActiveLock(tmpDir, 'repair')).resolves.toBeUndefined();
  });
});
