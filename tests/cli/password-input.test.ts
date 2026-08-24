import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPasswordFiles } from '../../src/cli/password-input.js';

describe('readPasswordFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bfs-pwfile-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // Regression: a password file saved by a Windows editor ends in CRLF. Stripping
  // only the LF left a stray '\r' in the password and rejected a correct credential.
  it('should strip a trailing CRLF so a Windows-saved password file authenticates', async () => {
    const file = join(dir, 'pw-crlf.txt');
    await writeFile(file, 'correct horse\r\n', 'utf-8');

    const [password] = await readPasswordFiles([file]);

    expect(password).toBe('correct horse');
  });

  it('should strip a trailing LF', async () => {
    const file = join(dir, 'pw-lf.txt');
    await writeFile(file, 'correct horse\n', 'utf-8');

    const [password] = await readPasswordFiles([file]);

    expect(password).toBe('correct horse');
  });

  it('should read a file with no trailing newline verbatim', async () => {
    const file = join(dir, 'pw-none.txt');
    await writeFile(file, 'correct horse', 'utf-8');

    const [password] = await readPasswordFiles([file]);

    expect(password).toBe('correct horse');
  });

  it('should trim only the final newline and preserve interior whitespace', async () => {
    const file = join(dir, 'pw-inner.txt');
    await writeFile(file, 'two words  spaced\r\n', 'utf-8');

    const [password] = await readPasswordFiles([file]);

    expect(password).toBe('two words  spaced');
  });

  it('should refuse a file that holds no password', async () => {
    const file = join(dir, 'pw-empty.txt');
    await writeFile(file, '\n', 'utf-8');

    // An empty read would become an empty password, which is falsy - and would
    // then degrade into the interactive prompt, i.e. a hang on the closed stdin
    // of a scheduled run. The point of the file is to supply a password.
    await expect(readPasswordFiles([file])).rejects.toThrow(file);
  });

  it('should name the file it could not read', async () => {
    const missing = join(dir, 'pw-absent.txt');

    // Continuing without a password would resurface much later as a failed
    // decryption on a storage device, pointing at the data instead of the typo.
    await expect(readPasswordFiles([missing])).rejects.toThrow(missing);
  });
});
