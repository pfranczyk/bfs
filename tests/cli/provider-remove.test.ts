import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
vi.mock('../../src/vault/vault-manager.js', () => ({
  listVersions: vi.fn(),
  removeProvider: vi.fn(),
}));
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
  Separator: class {
    type = 'separator';
  },
}));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/providers/provider.js')>();
  return {
    ...actual,
    createCliProviderIO: vi.fn(() => ({
      ask: vi.fn(),
      askSecret: vi.fn(),
      confirm: vi.fn(),
      choose: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      progress: vi.fn(),
    })),
  };
});

import inquirer from 'inquirer';
import { readConfig } from '../../src/vault/config.js';
import { listVersions, removeProvider } from '../../src/vault/vault-manager.js';

const mockReadConfig = vi.mocked(readConfig);
const mockListVersions = vi.mocked(listVersions);
const mockRemoveProvider = vi.mocked(removeProvider);
const mockPrompt = vi.mocked(inquirer.prompt);

describe('provider remove', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockListVersions.mockResolvedValue([]);
    mockRemoveProvider.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Brak konfiguracji ────────────────────────────────────────────────────

  it('should abort when no vault config', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['provider', 'remove', 'dysk-1']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('bfs init'))).toBe(true);
  });

  // ─── Rozwiązywanie ID / indeksu ───────────────────────────────────────────

  it('should accept provider by string ID', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    // Prompt was shown (strategy selection) — no "nie istnieje" error
    expect(capture.errors.some((l) => l.includes('nie istnieje'))).toBe(false);
  });

  it('should resolve numeric index 0 to provider ID', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    await runCmd(['provider', 'remove', '0']);

    expect(capture.errors.some((l) => l.includes('nie istnieje'))).toBe(false);
  });

  it('should resolve numeric index 1 to second provider', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    await runCmd(['provider', 'remove', '1']);

    expect(capture.errors.some((l) => l.includes('nie istnieje'))).toBe(false);
  });

  it('should abort with error for non-existent ID', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'remove', 'nieistniejący']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('does not exist'))).toBe(true);
  });

  it('should abort with error for out-of-range index', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'remove', '99']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('does not exist'))).toBe(true);
  });

  // ─── Bez argumentu — lista interaktywna ──────────────────────────────────

  it('should show interactive list when no argument given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ chosen: 'dysk-1' } as never) // lista providerów
      .mockResolvedValue({ strategy: 'cancel' } as never); // wybór strategii

    const result = await runCmd(['provider', 'remove']);

    expect(result).toBe('ok');
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'chosen' })]),
    );
  });

  it('should abort when no providers to choose from', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ providers: [] }) as never);

    const result = await runCmd(['provider', 'remove']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('No providers'))).toBe(true);
  });

  // ─── Strategia: cancel ────────────────────────────────────────────────────

  it('should return ok (not abort) when cancel strategy chosen', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    const result = await runCmd(['provider', 'remove', 'dysk-1']);

    expect(result).toBe('ok');
    expect(mockRemoveProvider).not.toHaveBeenCalled();
    expect(capture.logs.some((l) => l.includes('Cancelled'))).toBe(true);
  });

  // ─── Strategia: remove ────────────────────────────────────────────────────

  it('should call removeProvider with strategy=remove after confirmation', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ strategy: 'remove' } as never)
      .mockResolvedValueOnce({ confirmed: true } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({ strategy: 'remove' }),
    );
  });

  it('should not call removeProvider when confirmation declined', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ strategy: 'remove' } as never)
      .mockResolvedValueOnce({ confirmed: false } as never);

    const result = await runCmd(['provider', 'remove', 'dysk-1']);

    expect(result).toBe('ok');
    expect(mockRemoveProvider).not.toHaveBeenCalled();
  });

  // ─── Strategia: relocate ──────────────────────────────────────────────────

  it('should ask for new path with relocate strategy', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ strategy: 'relocate' } as never)
      .mockResolvedValueOnce({ newPath: '/mnt/new-disk' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'relocate',
        newConnectionConfig: { path: '/mnt/new-disk' },
      }),
    );
  });

  it('CI: --new-path with type:path prefix passes newType and stripped path', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'relocate',
      '--new-path',
      'local:/mnt/new-disk',
    ]);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'relocate',
        newConnectionConfig: { path: '/mnt/new-disk' },
        newType: 'local',
      }),
    );
  });

  it('CI: --new-type overrides type from --new-path prefix', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'relocate',
      '--new-path',
      '/mnt/new-disk',
      '--new-type',
      'local',
    ]);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'relocate',
        newConnectionConfig: { path: '/mnt/new-disk' },
        newType: 'local',
      }),
    );
  });

  it('CI: --new-path without type prefix uses path as-is and does not set newType', async () => {
    // Spec: ścieżka bez prefiksu typu przekazywana jest jako całość do newConnectionConfig.path
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'relocate',
      '--new-path',
      '/mnt/backup',
    ]);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'relocate',
        newConnectionConfig: { path: '/mnt/backup' },
      }),
    );
    const call = mockRemoveProvider.mock.calls[0][2];
    expect(call).not.toHaveProperty('newType');
  });

  it('interactive relocate: type:path format parsed from prompt answer', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ strategy: 'relocate' } as never)
      .mockResolvedValueOnce({ newPath: 'local:/mnt/new-disk' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'relocate',
        newConnectionConfig: { path: '/mnt/new-disk' },
        newType: 'local',
      }),
    );
  });

  // ─── Strategia: rebuild ───────────────────────────────────────────────────

  it('should ask for scope and target provider with rebuild strategy', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ strategy: 'rebuild' } as never)
      .mockResolvedValueOnce({ scope: 'all' } as never)
      .mockResolvedValueOnce({ targetId: 'dysk-2' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({
        strategy: 'rebuild',
        targetProviderId: 'dysk-2',
        rebuildScope: 'all',
      }),
    );
  });

  // ─── Tryb CI ──────────────────────────────────────────────────────────────

  it('CI: --strategy remove --yes skips all prompts', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'remove',
      '--yes',
    ]);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockRemoveProvider).toHaveBeenCalledWith(
      expect.any(String),
      'dysk-1',
      expect.objectContaining({ strategy: 'remove' }),
    );
  });

  it('CI: --strategy remove without --yes aborts', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'remove',
    ]);

    expect(result).toBe('abort');
    expect(mockRemoveProvider).not.toHaveBeenCalled();
  });

  it('CI: invalid --strategy value aborts', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd([
      'provider',
      'remove',
      'dysk-1',
      '--strategy',
      'bad',
    ]);

    expect(result).toBe('abort');
  });

  // ─── Wpływ na wersje ──────────────────────────────────────────────────────

  it('should show affected versions warning when provider used in manifests', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockListVersions.mockResolvedValue([
      {
        version: 1,
        health: 'healthy',
        shards: [{ provider_id: 'dysk-1', shard_index: 0, path: '' }],
      },
    ] as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(capture.errors.some((l) => l.includes('dysk-1'))).toBe(true);
  });
});
