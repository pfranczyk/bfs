import fs from 'node:fs/promises';
import path from 'node:path';
import { UnsafePathError } from './errors.js';

/**
 * Error codes with which a filesystem says it cannot open or flush a directory
 * at all (some network shares and FUSE mounts), as opposed to failing to store
 * data - modelled on what PostgreSQL tolerates when flushing a directory. EPERM
 * is deliberately absent: it is what Windows returns for a directory opened
 * without write access, and tolerating it would hide a wrong open mode.
 */
const UNSUPPORTED_DIR_SYNC_CODES = new Set(['EBADF', 'EINVAL', 'EACCES', 'EISDIR', 'ENOTSUP']);

/**
 * Returns true when an unknown error is a Node.js ENOENT (file/directory not found).
 * Use this to distinguish "file missing" from other I/O errors in catch blocks.
 */
export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Resolves a blob-relative entry path against rootDir and asserts it stays inside it.
 * The path-traversal / zip-slip guard for unpacking a backup whose file table may
 * originate from an untrusted source (tampered shards on a compromised provider).
 * Rejects NUL bytes, absolute paths (POSIX or Windows), `..` segments, and any path
 * that resolves outside rootDir.
 *
 * @param rootDir      Directory the entry must be written under.
 * @param relativePath Entry path as stored in the blob (forward-slash form).
 * @returns Absolute path, guaranteed contained within rootDir, safe to write.
 * @throws UnsafePathError if the path is absolute, contains `..` or NUL, or escapes rootDir.
 */
export function resolveSafeChildPath(rootDir: string, relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new UnsafePathError(relativePath, 'contains a NUL byte');
  }
  if (path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new UnsafePathError(relativePath, 'is an absolute path');
  }
  if (relativePath.split(/[/\\]/).some((segment) => segment === '..')) {
    throw new UnsafePathError(relativePath, 'contains a ".." segment');
  }
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new UnsafePathError(relativePath, 'escapes the target directory');
  }
  return resolved;
}

/**
 * Asserts a vault name is a single safe path segment before it is joined into a
 * storage path ({base}/{vaultName}/shard_...). Rejects path separators and the
 * relative segments `.` / `..` so a crafted or careless name cannot escape the
 * provider's base directory. This is the same BFS-core path-traversal invariant
 * as resolveSafeChildPath, scoped to a single segment; medium-specific dangers
 * (e.g. FTP control-channel CR/LF/NUL) remain the provider's responsibility.
 *
 * @param vaultName Vault name used as a directory segment on the medium.
 * @throws UnsafePathError if it contains "/", "\\", or is "." / "..".
 */
export function assertSafeVaultName(vaultName: string): void {
  if (vaultName.includes('/') || vaultName.includes('\\')) {
    throw new UnsafePathError(vaultName, 'contains a path separator');
  }
  if (vaultName === '.' || vaultName === '..') {
    throw new UnsafePathError(vaultName, 'is a relative path segment');
  }
}

/**
 * Asserts a single remote filename is a safe path segment before it is joined
 * into a storage path ({base}/{vault}/{filename}). Rejects empty names, path
 * separators, the relative segments `.` / `..`, and control characters
 * (CR / LF / NUL). Guards against a crafted `ref.path` or a hostile server's
 * readdir entry escaping the vault directory on the same medium.
 *
 * @param name Filename used as the final path segment on the medium.
 * @throws UnsafePathError if it is empty, contains "/" / "\\", is "." / "..", or holds a control char.
 */
export function assertSafeFilename(name: string): void {
  if (name.length === 0) {
    throw new UnsafePathError(name, 'is empty');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new UnsafePathError(name, 'contains a path separator');
  }
  if (name === '.' || name === '..') {
    throw new UnsafePathError(name, 'is a relative path segment');
  }
  if (/[\r\n\0]/.test(name)) {
    throw new UnsafePathError(name, 'contains a control character');
  }
}

/** Boolean form of {@link assertSafeFilename} - for filtering a server's readdir output. */
export function isSafeFilename(name: string): boolean {
  try {
    assertSafeFilename(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically and durably writes JSON to a file via .tmp + fsync + rename.
 * On POSIX and Windows, rename is atomic when source and destination are on
 * the same filesystem (parent directory of filePath), so a process dying
 * mid-write leaves at most the .tmp file behind but never a half-written
 * destination file; a write that fails without the process dying removes its
 * .tmp file before rethrowing. The temporary file is flushed before the
 * rename and the directory after it, so a power cut leaves either the old or
 * the new content too - without the first flush the kernel may persist the
 * rename ahead of the bytes and leave an empty file under the final name. A
 * filesystem that refuses the directory flush as unsupported is tolerated. A
 * missing parent directory is created owner-only (0700).
 *
 * @param filePath Absolute path to the destination file.
 * @param data JSON-serializable payload (pretty-printed with 2-space indent).
 * @throws on write, flush or rename failure - an I/O failure of the directory
 * flush arrives after the rename, with the new content already in place.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // The temp file is always freshly created, so its create-time mode sticks and
  // the atomic rename carries 0600 to the destination - keeping config, state
  // and forensic lock files owner-only on POSIX (no-op on Windows NTFS).
  try {
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await _fsyncPath(tmpPath, 'r+');
    await fs.rename(tmpPath, filePath);
  } catch (err: unknown) {
    // A failed write must not leave a copy behind - for config.json it holds
    // every storage secret. Only a process that dies here leaves one.
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
  // Windows flushes a directory only through a handle with write access, while
  // POSIX refuses to open a directory for writing (EISDIR).
  await _fsyncPath(dir, process.platform === 'win32' ? 'r+' : 'r').catch(_tolerateUnsupportedDirSync);
}

/**
 * By the time the directory is flushed the new file is already in place, so a
 * filesystem that does not support the flush must not turn a finished write
 * into a failed command; anything else is a real I/O failure and propagates.
 */
function _tolerateUnsupportedDirSync(err: unknown): void {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
  if (code !== undefined && UNSUPPORTED_DIR_SYNC_CODES.has(code)) return;
  throw err;
}

/** Flushes a file or directory to stable storage through a short-lived handle. */
async function _fsyncPath(target: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await fs.open(target, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
