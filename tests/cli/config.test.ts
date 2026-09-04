/**
 * Tests for src/cli/commands/config.ts
 *
 * Mocks readConfig/writeConfig from vault/config.js to avoid filesystem I/O.
 * Uses captureConsole() to assert on user-facing output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd, runCmdExitCode } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn().mockResolvedValue(undefined) }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, default: { ...(actual.default as Record<string, unknown>), stat: vi.fn().mockResolvedValue({ isDirectory: () => true }) } };
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
    // Each test owns its stat queue: mockResolvedValueOnce entries that a test
    // does not consume would otherwise be answered to the next one, which
    // silently moves what a failure proves.
    mockStat.mockReset();
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // --- Display (no args) ----------------------------------------------------

  it('should display current settings when no args given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/custom/cache', temp_dir: '/custom/tmp' }) as never);

    const result = await runCmd(['config']);

    expect(result).toBe('ok');
    const all = capture.logs.join('\n');
    expect(all).toContain('/custom/cache');
    expect(all).toContain('/custom/tmp');
  });

  it('should display (default) placeholder when cache_dir is null', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: null, temp_dir: null }) as never);

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

  // --- Set cache_dir --------------------------------------------------------

  it('should set cache_dir and call writeConfig when --cache-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['config', '--cache-dir', '/new/cache']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache_dir: '/new/cache' }));
  });

  it('should print config_updated on successful set', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--cache-dir', '/new/cache']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/updated|zaktualizowane/i);
  });

  // --- Set temp_dir ---------------------------------------------------------

  it('should set temp_dir and call writeConfig when --temp-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--temp-dir', '/custom/tmp']);

    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ temp_dir: '/custom/tmp' }));
  });

  // --- Reset cache_dir ------------------------------------------------------

  it('should reset cache_dir to null when --cache-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/old/cache' }) as never);

    const result = await runCmd(['config', '--cache-dir', '--reset']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache_dir: null }));
  });

  it('should print config_reset when reset performed', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/old/cache' }) as never);

    await runCmd(['config', '--cache-dir', '--reset']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/reset|default|domyśln/i);
  });

  // --- Reset temp_dir -------------------------------------------------------

  it('should reset temp_dir to null when --temp-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ temp_dir: '/old/tmp' }) as never);

    await runCmd(['config', '--temp-dir', '--reset']);

    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ temp_dir: null }));
  });

  // --- No writeConfig when nothing changes ----------------------------------

  it('should not call writeConfig when displaying settings (no args)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // --- Validation: reject nonexistent directories --------------------------

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

  // --- Validation: the leaf, the wording and the exit code -----------------

  // `bfs config` is the only writer of cache_dir / temp_dir, and push and pull
  // are the only readers. Writer and readers share one check
  // (validateConfigDir in vault/scratch-dir.ts), so a path the readers would
  // turn away cannot be stored here - otherwise the operator learns of it one
  // push later, from a message that sends them back to this command.

  it('should reject --temp-dir when the path exists as a file', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    // parent is a directory, the leaf itself is an existing file
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    const result = await runCmd(['config', '--temp-dir', '/parent/notadir']);

    expect(result, 'a refused setting must abort, not report success').toBe('abort');
    expect(mockWriteConfig, 'a path the readers reject must not reach config.json').not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all, 'the refusal must carry the one-command fix, as push and pull do').toContain('bfs config --temp-dir');
  });

  it('should reject --cache-dir when the path exists as a file', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    const result = await runCmd(['config', '--cache-dir', '/parent/notadir']);

    expect(result, 'a refused setting must abort, not report success').toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all).toContain('bfs config --cache-dir');
  });

  it('should give a reason the operator can act on when the parent is a file, not "does not exist"', async () => {
    // The parent resolves to an existing file. "Directory does not exist" reads
    // as "create it", and creating it is exactly what cannot be done here -
    // mkdir on that path fails with ENOTDIR however many times it is tried.
    // The refusal has to name the real obstacle, or the advice sends the
    // operator in a circle.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    await runCmd(['config', '--temp-dir', '/parent-is-a-file/tmp']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all.toLowerCase(), 'an obstacle that is not absence must not be reported as absence').not.toMatch(/does not exist|nie istnieje/i);
  });

  it('should exit non-zero when a directory setting is refused', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    const code = await runCmdExitCode(['config', '--temp-dir', 'Z:\\nonexistent\\tmp']);

    expect(code, 'a refusal that exits 0 cannot be told from a stored value by a script').toBe(1);
  });

  it('should accept a directory setting whose leaf does not exist yet (A/B control)', async () => {
    // The opposite side of the same check: push and pull create the leaf
    // themselves, so a missing one is not a fault and must still be stored.
    // Without this control the fix could be tightened into refusing every
    // path that is not already a directory.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await runCmd(['config', '--temp-dir', '/parent/not-yet-there']);

    expect(result).toBe('ok');
    expect(mockWriteConfig, 'a leaf BFS creates on first use must be accepted').toHaveBeenCalled();
  });
});
