import fs from 'node:fs/promises';
import path from 'node:path';
import {
  LockConcurrentActiveError,
  LockPartialStatePushError,
} from '../core/errors.js';
import { isEnoent, writeJsonAtomic } from '../core/fs-utils.js';

/** Schema version of push.lock / repair.lock JSON. */
export const LOCK_FORMAT_VERSION = 1;

/** Threshold above which an active-PID lock is treated as stale (ms). */
export const LOCK_STALE_MS = 24 * 60 * 60 * 1000;

/** Which long-running operation owns a given lockfile. */
export type LockOperation = 'push' | 'repair';

/** Reason a shard failed to upload, recorded in push.lock and used in CLI exit messages. */
export type PushLockFailedReason =
  | 'not_found'
  | 'mismatch'
  | 'auth_failed'
  | 'corrupted'
  | 'unverifiable'
  | 'network_error'
  | 'quota_exceeded'
  | 'unknown';

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
  scheme: {
    data_shards: number;
    parity_shards: number;
  };
  uploaded: PushLockUploadedEntry[];
  failed: PushLockFailedEntry[];
  blob_pending_path: string;
}

/** Pair successfully migrated by `bfs repair` (PR2 — schema only in PR1). */
export interface RepairLockSucceededPair {
  old_name: string;
  new_name: string;
  new_type?: string;
}

/** Pair that failed Phase A verify in `bfs repair` (PR2 — schema only in PR1). */
export interface RepairLockFailedPair {
  name: string;
  params: string;
  reason: PushLockFailedReason;
  detail: string;
}

/** Shard that failed Phase B/C rebuild or header-rewrite in `bfs repair` (PR2 — schema only in PR1). */
export interface RepairLockFailedShard {
  version: number;
  shard_index: number;
  pair_name: string;
  reason: PushLockFailedReason;
  detail: string;
}

/**
 * Forensic-state file (.bfs/repair.lock) written during `bfs repair`.
 * Schema present in PR1 so push.lock and repair.lock can coexist and clear
 * cleans up both proactively; write path activated by PR2.
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
export async function readLock<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/** Atomically writes a lockfile (via .tmp + rename in `writeJsonAtomic`). */
export async function writeLockAtomic<T>(
  filePath: string,
  lock: T,
): Promise<void> {
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
 * Pre-flight check for concurrent or partial-state operations.
 *
 * - For `push`: throws if any live lock exists, throws PartialState if a
 *   stale/dead lock exists. Push requires a clean vault.
 * - For `repair`: throws only on a live repair.lock. A stale repair.lock
 *   is left for idempotent retry; any push.lock (live or stale) is left
 *   for repair itself to consume.
 */
export async function assertNoActiveLock(
  rootDir: string,
  operation: LockOperation,
): Promise<void> {
  const pushLock = await readLock<PushLock>(pushLockPath(rootDir));
  const repairLock = await readLock<RepairLock>(repairLockPath(rootDir));

  switch (operation) {
    case 'push': {
      if (repairLock !== null) {
        if (isPidAlive(repairLock.pid) && !isLockStale(repairLock.started_at)) {
          throw new LockConcurrentActiveError(
            'repair',
            repairLock.pid,
            repairLock.started_at,
          );
        }
        throw new LockPartialStatePushError(0);
      }
      if (pushLock !== null) {
        if (isPidAlive(pushLock.pid) && !isLockStale(pushLock.started_at)) {
          throw new LockConcurrentActiveError(
            'push',
            pushLock.pid,
            pushLock.started_at,
          );
        }
        throw new LockPartialStatePushError(pushLock.version);
      }
      return;
    }
    case 'repair': {
      if (repairLock !== null) {
        if (isPidAlive(repairLock.pid) && !isLockStale(repairLock.started_at)) {
          throw new LockConcurrentActiveError(
            'repair',
            repairLock.pid,
            repairLock.started_at,
          );
        }
        return;
      }
      return;
    }
  }
}
