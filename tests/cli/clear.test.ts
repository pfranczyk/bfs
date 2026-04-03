/**
 * Tests for src/cli/commands/clear.ts
 *
 * Spies on fs.unlink and mocks vault/config.js readConfig to avoid filesystem I/O.
 * Uses captureConsole() to assert on user-facing output.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

import { readConfig } from '../../src/vault/config.js';

const mockReadConfig = vi.mocked(readConfig);

describe('clear', () => {
  let capture: ReturnType<typeof captureConsole>;
  let unlinkSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = captureConsole();
    unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    mockReadConfig.mockResolvedValue(null);
  });

  afterEach(() => {
    capture.restore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ─── Default cache dir ────────────────────────────────────────────────────

  it('should delete push.blob.pending from default cache dir when no config', async () => {
    const result = await runCmd(['clear']);

    expect(result).toBe('ok');
    const calledPaths = unlinkSpy.mock.calls.map(([p]: [unknown]) => String(p));
    expect(
      calledPaths.some(
        (p: string) => p.includes('.bfs') && p.endsWith('push.blob.pending'),
      ),
    ).toBe(true);
  });

  it('should delete pull.blob.pending from default cache dir when no config', async () => {
    await runCmd(['clear']);

    const calledPaths = unlinkSpy.mock.calls.map(([p]: [unknown]) => String(p));
    expect(
      calledPaths.some(
        (p: string) => p.includes('.bfs') && p.endsWith('pull.blob.pending'),
      ),
    ).toBe(true);
  });

  // ─── config.cache_dir fallback ────────────────────────────────────────────

  it('should use config.cache_dir when set in config.json', async () => {
    const customDir = path.join(path.sep, 'custom', 'cache');
    mockReadConfig.mockResolvedValue(
      makeConfig({ cache_dir: customDir }) as never,
    );

    await runCmd(['clear']);

    const calledPaths = unlinkSpy.mock.calls.map(([p]: [unknown]) => String(p));
    const expectedPush = path.join(customDir, 'push.blob.pending');
    expect(calledPaths).toContain(expectedPush);
  });

  // ─── --cache-dir flag priority ────────────────────────────────────────────

  it('should use --cache-dir flag over config.cache_dir', async () => {
    const configDir = path.join(path.sep, 'config', 'cache');
    const flagDir = path.join(path.sep, 'flag', 'cache');
    mockReadConfig.mockResolvedValue(
      makeConfig({ cache_dir: configDir }) as never,
    );

    await runCmd(['clear', '--cache-dir', flagDir]);

    const calledPaths = unlinkSpy.mock.calls.map(([p]: [unknown]) => String(p));
    const expectedPush = path.join(flagDir, 'push.blob.pending');
    const expectedPull = path.join(flagDir, 'pull.blob.pending');
    expect(calledPaths).toContain(expectedPush);
    expect(calledPaths).toContain(expectedPull);
    expect(calledPaths.every((p: string) => !p.startsWith(configDir))).toBe(
      true,
    );
  });

  // ─── Toleruje brakujące pliki ─────────────────────────────────────────────

  it('should succeed even when files do not exist (unlink rejects)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    unlinkSpy.mockRejectedValue(enoent);

    const result = await runCmd(['clear']);

    expect(result).toBe('ok');
  });

  // ─── Komunikat sukcesu ────────────────────────────────────────────────────

  it('should print clear_done on success', async () => {
    await runCmd(['clear']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/cache cleared|cache wyczyszczony/i);
  });
});
