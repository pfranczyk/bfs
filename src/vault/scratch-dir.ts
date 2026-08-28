import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { finished, Writable } from 'node:stream';
import { BfsError, ScratchWriteError } from '../core/errors.js';
import { fmt, t } from '../i18n/index.js';

/**
 * Removal attempts for a scratch directory. A scanner or indexer may hold a
 * freshly written part for a moment and answer EBUSY/EPERM; without retries
 * the directory - with parity or downloaded parts in it - stays behind.
 */
const SCRATCH_RM_RETRIES = 3;

/**
 * Validates a configured directory (`--cache-dir` / `--temp-dir`) before use:
 * its parent must exist and be a directory, and the leaf, when it already
 * exists, must be a directory too. A not-yet-existing leaf is accepted - the
 * operation creates it.
 *
 * @param dir - Directory path from the flag or the config
 * @param configFlag - Flag name for the hint (`cache-dir` / `temp-dir`)
 * @throws BfsError naming the path and the `bfs config` flag to fix it with
 */
export async function validateConfigDir(dir: string, configFlag: string): Promise<void> {
  const hint = fmt('config_dir_hint', configFlag, configFlag);
  const parent = path.dirname(dir) === dir ? dir : path.dirname(dir);
  const parentStat = await fs.stat(parent).catch(() => null);
  if (parentStat === null) throw new BfsError(`${fmt('dir_not_exist', dir)}\n  ${hint}`);
  if (!parentStat.isDirectory()) throw new BfsError(`${t('path_not_dir')}: ${dir}\n  ${hint}`);
  const leafStat = await fs.stat(dir).catch(() => null);
  if (leafStat !== null && !leafStat.isDirectory()) throw new BfsError(`${t('path_not_dir')}: ${dir}\n  ${hint}`);
}

/**
 * Makes an explicitly configured temp directory ready for a scratch directory:
 * validates it and creates the leaf, since mkdtemp does not create parents.
 *
 * @param dir - The configured temp directory
 * @throws BfsError naming the path when it is invalid or cannot be created
 */
export async function prepareExplicitTempDir(dir: string): Promise<void> {
  await validateConfigDir(dir, 'temp-dir');
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (e: unknown) {
    throw scratchWriteFailure(dir, e);
  }
}

/**
 * Creates a private scratch directory under `baseDir`. mkdtemp rather than a
 * predictable name: the system temp is shared, so a guessable path would be
 * open to link planting and the default mode would expose backup data.
 *
 * @param baseDir - Directory to create the scratch under (temp dir)
 * @param prefix - `bfs-push-` or `bfs-pull-`
 * @returns the created directory
 * @throws BfsError naming `baseDir` when the scratch cannot be created there
 */
export async function createScratchDir(baseDir: string, prefix: 'bfs-push-' | 'bfs-pull-'): Promise<string> {
  let dir: string;
  try {
    dir = await fs.mkdtemp(path.join(baseDir, prefix));
  } catch (e: unknown) {
    throw scratchWriteFailure(baseDir, e);
  }
  await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

/**
 * Removes a scratch directory with everything in it, retrying briefly when the
 * operating system still holds a file. A directory that cannot be removed is
 * left behind silently - the operation it served has already succeeded or
 * failed on its own terms.
 *
 * @param dir - The scratch directory
 */
export async function removeScratchDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: SCRATCH_RM_RETRIES }).catch(() => {});
}

/**
 * The error an operation reports when its scratch cannot be written: names the
 * temp location that refused and the one-command fix, keeps the cause.
 *
 * @param dir - Scratch directory, or the temp directory it could not be created in
 * @param cause - The operating system's error
 * @returns the error to throw or to print as a warning
 */
export function scratchWriteFailure(dir: string, cause: unknown): BfsError {
  return new BfsError(fmt('scratch_write_failed', dir, cause instanceof Error ? cause.message : String(cause)), { cause });
}

/**
 * A sink for one downloaded part that tags its own failures. A pipeline
 * reports the first error it sees, whichever stream raised it, and on an
 * error it destroys every stream with that same error - so the sink's
 * identity cannot be read off the stream afterwards. Wrapping the file stream
 * and tagging only what its own open, write and finish report is what lets the
 * caller tell a full scratch from a medium that stopped answering.
 *
 * @param filePath - Scratch file to write
 * @returns a Writable that fails with ScratchWriteError for the file's own faults
 */
export function createScratchSink(filePath: string): Writable {
  const file = createWriteStream(filePath, { mode: 0o600 });
  // The file stream's 'error' would otherwise be unhandled; its cause is read
  // back through `file.errored`, which is set before any callback fires, so a
  // write that fails only because the stream is already destroyed still names
  // the fault that destroyed it.
  file.on('error', () => {});
  const tagged = (err: unknown): ScratchWriteError => new ScratchWriteError(filePath, file.errored ?? err);
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      file.write(chunk, (err) => callback(err ? tagged(err) : null));
    },
    final(callback) {
      finished(file, (err) => callback(err ? tagged(err) : null));
      file.end();
    },
    destroy(err, callback) {
      file.destroy();
      callback(err);
    },
  });
}
