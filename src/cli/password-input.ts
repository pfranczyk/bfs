import fs from 'node:fs/promises';
import { BfsError } from '../core/errors.js';
import { fmt } from '../i18n/index.js';

/**
 * Reads each password file as UTF-8, trimming a single trailing newline (LF or
 * CRLF). The CRLF case matters on Windows, where an editor-saved password file
 * ends in `\r\n`; stripping only `\n` would leave a stray `\r` in the password
 * and reject an otherwise-correct credential.
 *
 * A password file exists so the secret never reaches the process argv, where
 * `/proc/<pid>/cmdline` exposes it to every local account for as long as the
 * command runs. That only helps if a file that cannot supply a password stops
 * the command: falling through to "no password given" would resurface much
 * later as a failed decryption on a storage device, pointing at the data rather
 * than at the file.
 *
 * @param paths - Password file paths, in the order they were given
 * @returns One password per path, in the same order
 * @throws BfsError if a file cannot be read, or holds nothing but whitespace
 */
export async function readPasswordFiles(paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    let content: string;
    try {
      content = await fs.readFile(p, 'utf-8');
    } catch {
      throw new BfsError(fmt('password_file_unreadable', p));
    }
    const password = content.replace(/\r?\n$/, '');
    if (password.trim() === '') throw new BfsError(fmt('password_file_empty', p));
    out.push(password);
  }
  return out;
}

/**
 * Resolves the single password a command should use, preferring what the
 * operator typed explicitly. Commands that carry a pool of passwords (repair,
 * recovery) combine both sources instead - a file must add to the pool there,
 * because different versions of a backup may use different passwords.
 *
 * @param inline - Value of `--password`, when given
 * @param files  - Values of `--password-file`, when given
 * @returns The password to use, or undefined when neither source supplied one
 * @throws BfsError if a password file cannot be read or is empty
 */
export async function resolvePassword(inline: string | undefined, files: string[]): Promise<string | undefined> {
  if (inline !== undefined) return inline;
  const [fromFile] = await readPasswordFiles(files);
  return fromFile;
}
