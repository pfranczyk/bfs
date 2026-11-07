import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PushExcludedError } from '../../src/core/errors.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { _formatExcludedList, _handleExcludedEntries } from '../../src/vault/push-pipeline.js';

// The refusal tells the operator to remove or rename the listed entries, so a
// name ending in a carriage return must not print as the plain name next to
// it, and a line feed must not split one entry into two list lines.
describe('_formatExcludedList', () => {
  it('should show a name with a control character escaped on one line', () => {
    const entries = [
      { path: 'notes\r', reason: 'symlink' as const },
      { path: 'a\nb', reason: 'symlink' as const },
    ];

    const out = _formatExcludedList(entries);

    expect(out).toContain('"notes\\r"');
    expect(out).toContain('"a\\nb"');
    expect(out).not.toContain('\r');
    expect(out.split('\n')).toHaveLength(2);
  });
});

// Real symlinks need admin/developer mode on Windows, so this integration of the
// excluded-entries gate is POSIX-only. Cross-OS classification is covered by
// tests/core/scan-classified.test.ts (mock Dirent).
const describeOrSkip = process.platform === 'win32' ? describe.skip : describe;

describeOrSkip('_handleExcludedEntries (real symlink, POSIX)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bfs-excluded-'));
    await writeFile(join(dir, 'real.txt'), 'content');
    await symlink('real.txt', join(dir, 'link.txt')); // symlink -> file
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('should throw PushExcludedError in non-interactive mode', async () => {
    const { io } = createMockProviderIO({}, dir, false);
    await expect(_handleExcludedEntries({ rootDir: dir, interactive: false, io })).rejects.toThrow(PushExcludedError);
  });

  it('should return the excluded entries (and warn) with allowExcluded', async () => {
    const { io, logs } = createMockProviderIO({}, dir, false);
    const result = await _handleExcludedEntries({ rootDir: dir, allowExcluded: true, interactive: false, io });
    expect(result).toEqual([{ path: 'link.txt', reason: 'symlink' }]);
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('should append to .bfsignore and clear when the user accepts interactively', async () => {
    const { io } = createMockProviderIO({}, dir, true);
    vi.spyOn(io, 'confirm').mockResolvedValue(true);

    const result = await _handleExcludedEntries({ rootDir: dir, interactive: true, io });

    expect(result).toEqual([]); // added to .bfsignore, the re-scan is clean
    const content = await readFile(join(dir, '.bfsignore'), 'utf-8');
    expect(content).toContain('/link.txt');
  });

  it('should abort when the user declines the interactive prompt', async () => {
    const { io } = createMockProviderIO({}, dir, true);
    vi.spyOn(io, 'confirm').mockResolvedValue(false);
    await expect(_handleExcludedEntries({ rootDir: dir, interactive: true, io })).rejects.toThrow(BfsError);
  });

  // A line feed cannot be written into a .bfsignore line at all, and a literal
  // carriage return can only sit inside a bracket, where any editor or
  // line-ending conversion that treats it as a line break splits the pattern -
  // so the gate refuses such a name and must stop instead of re-appending
  // forever (without the guard this test hangs and fails via timeout). The
  // refusal must also leave no line behind: a name
  // ending in `\r` is read back as the same name without it, and a name with an
  // inner `\n` splits into two lines, the second one unanchored. Either line
  // would later drop a regular file from every backup while push reports
  // success.
  it.each([
    ['a trailing carriage return', 'notes\r', ['notes']],
    ['an inner line feed', 'a\nb', ['a', 'b', 'sub/b']],
  ])(
    'should stop on a name with %s and leave no line that excludes other files',
    async (_label, name, others) => {
      await symlink('real.txt', join(dir, name));
      const { io } = createMockProviderIO({}, dir, true);
      vi.spyOn(io, 'confirm').mockResolvedValue(true);

      await expect(_handleExcludedEntries({ rootDir: dir, interactive: true, io })).rejects.toThrow(BfsError);

      const filter = createIgnoreFilter(dir);
      for (const other of others) {
        expect(filter(other), `${JSON.stringify(other)} must stay in the backup`).toBe(false);
      }
    },
    10000,
  );
});
