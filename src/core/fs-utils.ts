import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Returns true when an unknown error is a Node.js ENOENT (file/directory not found).
 * Use this to distinguish "file missing" from other I/O errors in catch blocks.
 */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * Atomically writes JSON to a file via .tmp + rename.
 * On POSIX and Windows, rename is atomic when source and destination are on
 * the same filesystem (parent directory of filePath). A crash mid-write leaves
 * the .tmp file behind (cleanup is the caller's responsibility) but never a
 * half-written destination file.
 *
 * @param filePath Absolute path to the destination file.
 * @param data JSON-serializable payload (pretty-printed with 2-space indent).
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, filePath);
}
