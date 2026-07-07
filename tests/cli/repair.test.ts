import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPasswordFiles } from '../../src/cli/commands/repair.js';

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
});
