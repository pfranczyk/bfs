/**
 * Tests for src/cli/commands/config.ts
 *
 * Mocks readConfig/writeConfig from vault/config.js to avoid filesystem I/O.
 * Uses captureConsole() to assert on user-facing output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
    },
  };
});

import fsMock from 'node:fs/promises';
import { readConfig, writeConfig } from '../../src/vault/config.js';

const mockStat = vi.mocked(fsMock.stat);
const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);

describe('config', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Display (no args) ────────────────────────────────────────────────────

  it('should display current settings when no args given', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({
        cache_dir: '/custom/cache',
        temp_dir: '/custom/tmp',
      }) as never,
    );

    const result = await runCmd(['config']);

    expect(result).toBe('ok');
    const all = capture.logs.join('\n');
    expect(all).toContain('/custom/cache');
    expect(all).toContain('/custom/tmp');
  });

  it('should display (default) placeholder when cache_dir is null', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ cache_dir: null, temp_dir: null }) as never,
    );

    await runCmd(['config']);

    const all = capture.logs.join('\n');
    expect(all).toContain('default');
  });

  it('should print error when no config found', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['config']);

    expect(result).toBe('ok');
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/no backup|brak/i);
  });

  // ─── Set cache_dir ────────────────────────────────────────────────────────

  it('should set cache_dir and call writeConfig when --cache-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['config', '--cache-dir', '/new/cache']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache_dir: '/new/cache' }),
    );
  });

  it('should print config_updated on successful set', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--cache-dir', '/new/cache']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/updated|zaktualizowane/i);
  });

  // ─── Set temp_dir ─────────────────────────────────────────────────────────

  it('should set temp_dir and call writeConfig when --temp-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--temp-dir', '/custom/tmp']);

    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temp_dir: '/custom/tmp' }),
    );
  });

  // ─── Reset cache_dir ──────────────────────────────────────────────────────

  it('should reset cache_dir to null when --cache-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ cache_dir: '/old/cache' }) as never,
    );

    const result = await runCmd(['config', '--cache-dir', '--reset']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cache_dir: null }),
    );
  });

  it('should print config_reset when reset performed', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ cache_dir: '/old/cache' }) as never,
    );

    await runCmd(['config', '--cache-dir', '--reset']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/reset|default|domyśln/i);
  });

  // ─── Reset temp_dir ───────────────────────────────────────────────────────

  it('should reset temp_dir to null when --temp-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({ temp_dir: '/old/tmp' }) as never,
    );

    await runCmd(['config', '--temp-dir', '--reset']);

    expect(mockWriteConfig).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temp_dir: null }),
    );
  });

  // ─── No writeConfig when nothing changes ──────────────────────────────────

  it('should not call writeConfig when displaying settings (no args)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── Validation: reject nonexistent directories ──────────────────────────

  it('should reject --cache-dir when parent directory does not exist', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    await runCmd(['config', '--cache-dir', 'Z:\\nonexistent\\cache']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not exist|nie istnieje/i);
  });

  it('should reject --temp-dir when parent directory does not exist', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    await runCmd(['config', '--temp-dir', 'Z:\\nonexistent\\tmp']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not exist|nie istnieje/i);
  });
});
