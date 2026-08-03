import fs from 'node:fs/promises';
import path from 'node:path';
import { LockConcurrentActiveError, LockPartialStatePushError } from '../core/errors.js';
import { isEnoent, writeJsonAtomic } from '../core/fs-utils.js';

/** Schema version of push.lock / repair.lock JSON. */
export const LOCK_FORMAT_VERSION = 1;

/** Threshold above which an active-PID lock is treated as stale (ms). */
export const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** Reason a shard failed to upload, recorded in push.lock and used in CLI exit messages. */
export type PushLockFailedReason = 'not_found' | 'mismatch' | 'auth_failed' | 'corrupted' | 'unverifiable' | 'network_error' | 'quota_exceeded' | 'unknown';

/** Entry appended to push.lock.uploaded after each successful shard upload. */
export interface PushLockUploadedEntry {
  shard_index: number;
  provider_id: string;
}

/** Entry appended to push.lock.failed when a shard upload throws. */
export interface PushLockFailedEntry {
  shard_index: number;
  provider_id: string;
  reason: PushLockFailedReason;
  detail: string;
  attempted_at: string;
}

/** Forensic-state file (.bfs/push.lock) written during `bfs push`. */
export interface PushLock {
  format_version: number;
  operation: 'push';
  version: number;
  pid: number;
  command: string;
  started_at: string;
  scheme: { data_shards: number; parity_shards: number };
  uploaded: PushLockUploadedEntry[];
  failed: PushLockFailedEntry[];
  /**
   * Path of the cached blob this lock promises, or `null` when no resumable
   * cache exists. `bfs push --cache` consults this field: a string means
   * the resume path expects to find the blob at that path; `null` means
   * resume is impossible and the lock can only be discarded via `bfs clear`.
   */
  blob_pending_path: Nullable<string>;
}

/** Pair successfully migrated by `bfs repair`. */
export interface RepairLockSucceededPair {
  old_name: string;
  new_name: string;
  new_type?: string;
}

/** Pair that failed Phase A verify in `bfs repair`. */
export interface RepairLockFailedPair {
  name: string;
  params: string;
  reason: PushLockFailedReason;
  detail: string;
}

/** Shard that failed Phase B/C rebuild or header-rewrite in `bfs repair`. */
export interface RepairLockFailedShard {
  version: number;
  shard_index: number;
  pair_name: string;
  reason: PushLockFailedReason;
  detail: string;
}

/**
 * Forensic-state schema for `.bfs/repair.lock`. The lock is detected by the
 * active-lock guard and removed by `bfs clear`, alongside push.lock.
 */
export interface RepairLock {
  format_version: number;
  operation: 'repair';
  version_range: string;
  pid: number;
  command: string;
  started_at: string;
  succeeded_pairs: RepairLockSucceededPair[];
  failed_pairs: RepairLockFailedPair[];
  failed_shards: RepairLockFailedShard[];
}

/** Returns the path where push.lock lives for the given vault root. */
export function pushLockPath(rootDir: string): string {
  return path.join(rootDir, '.bfs', 'push.lock');
}

/** Returns the path where repair.lock lives for the given vault root. */
export function repairLockPath(rootDir: string): string {
  return path.join(rootDir, '.bfs', 'repair.lock');
}

/**
 * Reads a lockfile and parses its JSON. Returns null when the file does not
 * exist (also tolerates ENOENT mid-flight when a concurrent `bfs clear`
 * removes the file between stat and read).
 */
export async function readLock<T>(filePath: string): Promise<Nullable<T>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Atomically writes a lockfile (via .tmp + rename in `writeJsonAtomic`). */
export async function writeLockAtomic<T>(filePath: string, lock: T): Promise<void> {
  await writeJsonAtomic(filePath, lock);
}

/** Removes a lockfile. Tolerates ENOENT (no-op when already gone). */
export async function removeLock(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (!isEnoent(err)) throw err;
  }
}

/**
 * Probes whether a PID belongs to a live process. Cross-platform:
 * POSIX and Windows both implement `process.kill(pid, 0)` as a liveness
 * check (ESRCH = dead, EPERM = alive but not ours).
 *
 * Pessimistic default: any unexpected throw → false (treat as dead). This
 * surfaces stale partial state to the user instead of blocking a fresh
 * push when our liveness probe itself fails.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/** Returns true when the lock was opened more than LOCK_STALE_MS ago. */
export function isLockStale(started_at: string): boolean {
  const t = Date.parse(started_at);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > LOCK_STALE_MS;
}

/**
 * Max attempts to atomically take over a stale lock before treating persistent
 * contention as an active peer. Only exhausted under pathological churn (a peer
 * re-creating the lock every iteration).
 */
const LOCK_ACQUIRE_ATTEMPTS = 10;

/**
 * True when a lock's owning process is alive AND the lock is younger than
 * LOCK_STALE_MS — i.e. someone is actively holding it right now.
 */
export function isLockLive(lock: { pid: number; started_at: string }): boolean {
  return isPidAlive(lock.pid) && !isLockStale(lock.started_at);
}

/**
 * Reads and parses a lockfile, returning null for BOTH a missing file and a
 * torn/unparseable one. Used after an exclusive create loses the race: the peer
 * that just won may be mid-write, leaving a briefly empty file. Treating that as
 * "no readable owner" lets the caller classify it as leftover state instead of
 * crashing on JSON.parse.
 */
async function readLockSafe<T>(filePath: string): Promise<Nullable<T>> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (isEnoent(err) || err instanceof SyntaxError) return null;
    throw err;
  }
}

/**
 * Atomically creates a lockfile with O_EXCL (flag 'wx') and writes the JSON
 * payload to the open handle. The exclusive create IS the mutual-exclusion
 * point: of any number of racing callers, exactly one create succeeds.
 *
 * @returns true when this caller created (owns) the file; false on EEXIST.
 */
async function createLockExclusive<T>(filePath: string, lock: T): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 'wx' = O_CREAT | O_EXCL | O_WRONLY; mode 0o600 keeps forensic locks
  // owner-only on POSIX (no-op on Windows NTFS).
  const handle = await fs.open(filePath, 'wx', 0o600).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw err;
  });
  if (handle === null) return false;
  try {
    await handle.writeFile(JSON.stringify(lock, null, 2), { encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
  return true;
}

/**
 * Atomically acquires .bfs/push.lock for a fresh push, writing `lock` as the
 * forensic payload. The exclusive create serialises concurrent pushes: exactly
 * one wins the race, the losers are rejected — closing the TOCTOU window that a
 * read-then-write pre-flight left open.
 *
 * @throws LockConcurrentActiveError when a live push or repair already holds the vault
 * @throws LockPartialStatePushError when a dead/stale push.lock or repair.lock leftover is present (push requires a clean vault)
 */
export async function acquirePushLock(rootDir: string, lock: PushLock): Promise<void> {
  // repair.lock is a separate file, so it stays a read-check: a live repair
  // blocks, a dead one is partial state. The push-vs-push race is closed by the
  // exclusive create below, not by this read.
  const repairLock = await readLock<RepairLock>(repairLockPath(rootDir));
  if (repairLock !== null) {
    if (isLockLive(repairLock)) throw new LockConcurrentActiveError('repair', repairLock.pid, repairLock.started_at);
    throw new LockPartialStatePushError(0);
  }
  if (await createLockExclusive(pushLockPath(rootDir), lock)) return;
  // EEXIST: another push created push.lock first (or crashed holding it).
  const existing = await readLockSafe<PushLock>(pushLockPath(rootDir));
  if (existing !== null && isLockLive(existing)) {
    throw new LockConcurrentActiveError('push', existing.pid, existing.started_at);
  }
  throw new LockPartialStatePushError(existing?.version ?? 0);
}

/**
 * Acquires .bfs/push.lock for a `--cache` resume. Unlike a fresh push, the lock
 * is expected to already exist (the crashed push being resumed), so O_EXCL
 * cannot apply. Refuses only when a DIFFERENT live process currently holds it
 * (or a live repair does); otherwise the caller's fresh forensic content
 * replaces the dead/own lock. Callers must have already validated the resume
 * state (cached blob present).
 *
 * @throws LockConcurrentActiveError when a live repair, or a live foreign push, holds the vault
 */
export async function acquireCachePushLock(rootDir: string, lock: PushLock): Promise<void> {
  const repairLock = await readLock<RepairLock>(repairLockPath(rootDir));
  if (repairLock !== null && isLockLive(repairLock)) {
    throw new LockConcurrentActiveError('repair', repairLock.pid, repairLock.started_at);
  }
  const existing = await readLockSafe<PushLock>(pushLockPath(rootDir));
  if (existing !== null && existing.pid !== process.pid && isLockLive(existing)) {
    throw new LockConcurrentActiveError('push', existing.pid, existing.started_at);
  }
  await writeLockAtomic(pushLockPath(rootDir), lock);
}

/**
 * Atomically acquires .bfs/repair.lock, writing `lock` as the forensic payload.
 * The exclusive create serialises concurrent repairs; a dead/stale repair.lock
 * is taken over (idempotent retry). A live push holds the vault, so repair
 * refuses (first-to-start wins); a dead/stale push.lock is leftover partial
 * state that repair is meant to recover, so it does not block.
 *
 * @throws LockConcurrentActiveError when a live push, or a live repair, already holds the vault
 */
export async function acquireRepairLock(rootDir: string, lock: RepairLock): Promise<void> {
  const pushLock = await readLock<PushLock>(pushLockPath(rootDir));
  if (pushLock !== null && isLockLive(pushLock)) {
    throw new LockConcurrentActiveError('push', pushLock.pid, pushLock.started_at);
  }
  const lockPath = repairLockPath(rootDir);
  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    if (await createLockExclusive(lockPath, lock)) return;
    const existing = await readLockSafe<RepairLock>(lockPath);
    if (existing !== null && isLockLive(existing)) {
      throw new LockConcurrentActiveError('repair', existing.pid, existing.started_at);
    }
    // Dead / stale / torn leftover — drop it and retry the exclusive create. A
    // peer that recreates it first re-triggers the liveness check next round.
    await removeLock(lockPath);
  }
  // Persistent contention: a peer keeps re-acquiring — treat as active.
  const existing = await readLockSafe<RepairLock>(lockPath);
  throw new LockConcurrentActiveError('repair', existing?.pid ?? 0, existing?.started_at ?? new Date().toISOString());
}
