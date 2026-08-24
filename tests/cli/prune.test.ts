import { ExitPromptError } from '@inquirer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn(), prune: vi.fn(), assertPruneKeepsARestorableVersion: vi.fn() }));
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
    Separator: class {
      type = 'separator';
    },
  },
  Separator: class {
    type = 'separator';
  },
}));

import inquirer from 'inquirer';
import { assertPruneKeepsARestorableVersion, listVersions, prune } from '../../src/vault/vault-manager.js';

const mockListVersions = vi.mocked(listVersions);
const mockPrune = vi.mocked(prune);
const mockGuard = vi.mocked(assertPruneKeepsARestorableVersion);
const mockPrompt = vi.mocked(inquirer.prompt);

function makeManifests(versions: number[]) {
  return versions.map((v) => ({
    version: v,
    health: VersionHealth.Healthy,
    shards: [],
    created_at: new Date().toISOString(),
    source_hash: '',
    total_size: 0,
    file_count: 0,
    scheme: { data_shards: 2, parity_shards: 1 },
    providers: [],
    encryption: false,
  }));
}

describe('prune', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockPrune.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // --- No versions ----------------------------------------------------------

  it('should show message when no versions exist', async () => {
    mockListVersions.mockResolvedValue([]);

    await runCmd(['prune']);

    expect(capture.logs.some((l) => l.includes('No versions'))).toBe(true);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  // --- Range as an argument -------------------------------------------------

  it('should prune single version', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '2']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [2] }));
  });

  it('should prune range 1-3', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3, 4, 5]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '1-3']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [1, 2, 3] }));
  });

  it('should prune comma-separated versions', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3, 4, 5]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '1,3,5']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [1, 3, 5] }));
  });

  it('should ignore non-existent versions in range silently', async () => {
    mockListVersions.mockResolvedValue(makeManifests([3, 4, 5]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '1-5']);

    // Only versions that exist (3,4,5) should be passed
    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [3, 4, 5] }));
  });

  it('should show message when range matches no existing versions', async () => {
    mockListVersions.mockResolvedValue(makeManifests([5, 6, 7]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '1-4']);

    expect(capture.logs.some((l) => l.includes('No versions'))).toBe(true);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('should abort on invalid range format', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2]) as never);

    const result = await runCmd(['prune', 'abc']);

    expect(result).toBe('abort');
  });

  // --- --keep-last ----------------------------------------------------------

  it('should keep last 2 versions and prune the rest', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3, 4, 5]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '--keep-last', '2']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [1, 2, 3] }));
  });

  it('should show message when --keep-last >= total versions', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2]) as never);
    mockPrompt.mockResolvedValue({ confirmed: true } as never);

    await runCmd(['prune', '--keep-last', '5']);

    expect(capture.logs.some((l) => l.includes('No versions'))).toBe(true);
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('should abort when --keep-last < 1', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2]) as never);

    const result = await runCmd(['prune', '--keep-last', '0']);

    expect(result).toBe('abort');
  });

  // --- --yes (CI mode) ------------------------------------------------------

  it('should skip confirmation with --yes flag', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);

    await runCmd(['prune', '1', '--yes']);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockPrune).toHaveBeenCalled();
  });

  it('should not prune when confirmation declined', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt.mockResolvedValue({ confirmed: false } as never);

    const result = await runCmd(['prune', '1']);

    expect(result).toBe('ok');
    expect(mockPrune).not.toHaveBeenCalled();
    expect(capture.logs.some((l) => l.includes('Cancelled'))).toBe(true);
  });

  // --- Without an argument - interactive list ----------------------------------

  it('should show checkbox list when no argument provided', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt
      .mockResolvedValueOnce({ picked: ['2'] } as never) // checkbox
      .mockResolvedValueOnce({ confirmed: true } as never); // confirmation

    await runCmd(['prune']);

    expect(mockPrompt).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: 'checkbox', name: 'picked' })]));
    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [2] }));
  });

  it('should show nothing to prune when 0 versions selected in interactive mode', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt.mockResolvedValueOnce({ picked: [] } as never);

    await runCmd(['prune']);

    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('interactive: manual range entry when __manual__ selected', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt
      .mockResolvedValueOnce({ picked: ['__manual__'] } as never)
      .mockResolvedValueOnce({ rangeInput: '1-2' } as never)
      .mockResolvedValueOnce({ confirmed: true } as never);

    await runCmd(['prune']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [1, 2] }));
  });

  // --- Cancellation -----------------------------------------------------------

  it('should treat ExitPromptError as empty selection during checkbox', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt.mockRejectedValueOnce(new ExitPromptError() as never);

    const result = await runCmd(['prune']);

    expect(result).toBe('ok');
    expect(mockPrune).not.toHaveBeenCalled();
  });

  it('should treat ExitPromptError as decline during confirmation', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2, 3]) as never);
    mockPrompt.mockRejectedValueOnce(new ExitPromptError() as never);

    const result = await runCmd(['prune', '1']);

    expect(result).toBe('ok');
    expect(mockPrune).not.toHaveBeenCalled();
    expect(capture.logs.some((l) => l.includes('Cancelled') || l.includes('Anulowano'))).toBe(true);
  });

  // --- Guard on the last restorable version ---------------------------------

  it('should pass --force through to the prune call', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2]) as never);

    await runCmd(['prune', '1', '--yes', '--force']);

    expect(mockPrune).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ versions: [1], force: true }));
  });

  it('should check the guard before asking for confirmation', async () => {
    mockListVersions.mockResolvedValue(makeManifests([1, 2]) as never);
    mockGuard.mockRejectedValueOnce(new Error('would leave no version that can still be restored'));

    const result = await runCmd(['prune', '1']);

    expect(result).toBe('abort');
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockPrune).not.toHaveBeenCalled();
  });
});
