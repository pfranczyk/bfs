import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PushExcludedError } from '../../src/core/errors.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { _handleExcludedEntries } from '../../src/vault/push-pipeline.js';

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

  it('should stop (not loop forever) for a name that cannot be represented in .bfsignore', async () => {
    // A trailing space in a name has no matching .bfsignore pattern (the ignore
    // engine trims it), so appending + rescanning never clears it. The progress
    // guard must break with an error instead of re-appending forever. If the
    // guard were missing this test would hang and fail via timeout.
    await symlink('real.txt', join(dir, 'trailing '));

    const { io } = createMockProviderIO({}, dir, true);
    vi.spyOn(io, 'confirm').mockResolvedValue(true);

    await expect(_handleExcludedEntries({ rootDir: dir, interactive: true, io })).rejects.toThrow(BfsError);
  }, 10000);
});
