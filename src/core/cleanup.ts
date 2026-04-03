import fs from 'node:fs';

/**
 * Tracks in-flight files (e.g. push/pull pending blobs) and removes them on SIGINT.
 * Use trackFile() before starting a write; untrackFile() after the file is intentionally kept.
 * On Ctrl+C the handler removes all tracked files and exits with code 130.
 *
 * Handler is registered once on first trackFile() call.
 * Uses fs.unlinkSync because async I/O is not guaranteed inside a SIGINT handler.
 */

const pendingFiles = new Set<string>();
let registered = false;

/** Registers the file for cleanup on SIGINT. Installs the handler on first call. */
export function trackFile(filePath: string): void {
  pendingFiles.add(filePath);
  if (!registered) {
    registered = true;
    process.on('SIGINT', _cleanup);
  }
}

/** Removes the file from the cleanup set (file is intentionally kept, e.g. for --cache retry). */
export function untrackFile(filePath: string): void {
  pendingFiles.delete(filePath);
}

function _cleanup(): void {
  for (const filePath of pendingFiles) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort — file may not exist yet
    }
  }
  process.exit(130);
}
