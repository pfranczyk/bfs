import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The test harnesses mark a failed scenario with `[[X]]`, which the CI log
 * trimmer greps for when it cuts a job log down to the failure blocks. The
 * token is bracketed because a bare `X` is already the prefix `error()` puts on
 * every CLI error message, so a passing test that asserts an error path would
 * be reported as a failure.
 *
 * That marker belongs to the harnesses alone. If it ever reaches `src/`, a user
 * running `bfs` sees `[[X]] Backup not found` instead of `X Backup not found` -
 * a debug token leaking into the product. This suite fails the build first.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKER = '[[X]]';

/**
 * Collects every file under a directory, recursively.
 *
 * @param dir - absolute path to walk
 * @returns absolute paths of all regular files found beneath it
 */
async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(full)));
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
  return found;
}

describe('harness failure marker', () => {
  it('should never appear in src/ - it is a harness token, not user-facing output', async () => {
    const files = await walk(path.join(ROOT, 'src'));
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(file, 'utf8');
      if (text.includes(MARKER)) offenders.push(path.relative(ROOT, file).split(path.sep).join('/'));
    }
    expect(offenders, `${MARKER} leaked into src/ - it would show up in real CLI output`).toEqual([]);
  });

  it('should be emitted by every harness that reports a failure', async () => {
    const producers = [
      'scripts/cli-e2e/lib/report.sh',
      'scripts/cli-e2e/lib/assert.sh',
      'scripts/cli-e2e/lib/hash.sh',
      'scripts/smoke-runner.ts',
      'scripts/compat-fixtures/run.sh',
      'scripts/cross-os/restore.sh',
      'scripts/cross-os/ftp-restore.sh',
    ];
    for (const rel of producers) {
      const text = await fs.readFile(path.join(ROOT, rel), 'utf8');
      expect(text, `${rel} no longer emits ${MARKER}`).toContain(MARKER);
    }
  });
});
