import fs from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';

/** Message of the error an interrupted write fails with. */
export const SIMULATED_CRASH = 'simulated crash mid-write';

/**
 * Makes every `fs.writeFile` land the first half of its payload, then fail -
 * the shape a process that dies inside the write leaves on disk. Undo with
 * `vi.restoreAllMocks()`.
 */
export function interruptWritesHalfway(): void {
  const realWriteFile = fs.writeFile.bind(fs);
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    const text = String(data);
    await realWriteFile(file, text.slice(0, Math.floor(text.length / 2)), options);
    throw new Error(SIMULATED_CRASH);
  });
}

/**
 * Returns the identity of the file at `filePath` (inode on POSIX, file ID on
 * NTFS). A write that replaces the file by renaming a finished copy over it
 * changes this value; one that rewrites the file in place does not.
 */
export async function fileIdentity(filePath: string): Promise<bigint> {
  return (await fs.stat(filePath, { bigint: true })).ino;
}

/** Lists the leftover temporary files next to `filePath`. */
export async function strayTempFiles(filePath: string): Promise<string[]> {
  const base = path.basename(filePath);
  return (await fs.readdir(path.dirname(filePath))).filter((name) => name.startsWith(`${base}.`) && name.endsWith('.tmp'));
}
