import { ExitPromptError } from '@inquirer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
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
      lang: 'en',
      workDir: process.cwd(),
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
import { FtpProvider } from '../../src/providers/ftp.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listVersions, removeProvider } from '../../src/vault/vault-manager.js';

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);
const mockListVersions = vi.mocked(listVersions);
const mockRemoveProvider = vi.mocked(removeProvider);
const mockPrompt = vi.mocked(inquirer.prompt);

describe('provider remove', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockListVersions.mockResolvedValue([]);
    mockRemoveProvider.mockResolvedValue(undefined as never);
    mockWriteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
    vi.restoreAllMocks();
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

  // ─── Strategia: relocate (pass-through) ──────────────────────────────────
  // Kontrakt: BFS zna tylko --strategy, --new-type, --password. Wszystko inne
  // idzie do adaptera jako rawArgs; adapter sam zbiera config przez
  // configureFromFlags / configureInteractive.

  describe('relocate strategy', () => {
    beforeEach(() => {
      vi.spyOn(
        LocalFsProvider.prototype,
        'configureFromFlags',
      ).mockResolvedValue({ path: '/adapter/new' });
      vi.spyOn(
        LocalFsProvider.prototype,
        'configureInteractive',
      ).mockResolvedValue({ path: '/adapter/int' });
      vi.spyOn(LocalFsProvider.prototype, 'validateConfig').mockReturnValue([]);
      vi.spyOn(FtpProvider.prototype, 'configureFromFlags').mockResolvedValue({
        host: 'f',
        port: 21,
        user: 'u',
        password: 'p',
        path: '/b',
        secure: false,
      });
      vi.spyOn(FtpProvider.prototype, 'configureInteractive').mockResolvedValue(
        {
          host: 'f',
          port: 21,
          user: 'u',
          password: 'p',
          path: '/b',
          secure: false,
        },
      );
      vi.spyOn(FtpProvider.prototype, 'validateConfig').mockReturnValue([]);
    });

    it('CI: forwards unknown flags verbatim as rawArgs to configureFromFlags', async () => {
      const spy = vi.mocked(LocalFsProvider.prototype.configureFromFlags);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--config-file',
        './new.json',
      ]);

      expect(spy).toHaveBeenCalledOnce();
      const [input] = spy.mock.calls[0];
      expect(input.name).toBe('dysk-1');
      expect(input.rawArgs).toEqual(['--config-file', './new.json']);
      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({
          strategy: 'relocate',
          newConnectionConfig: { path: '/adapter/new' },
        }),
      );
    });

    it('CI: without --new-type keeps current provider type (no newType in call)', async () => {
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--config-file',
        './new.json',
      ]);

      const call = mockRemoveProvider.mock.calls[0][2];
      expect(call).not.toHaveProperty('newType');
    });

    it('CI: --new-type switches factory and sets newType on removeProvider', async () => {
      const ftpSpy = vi.mocked(FtpProvider.prototype.configureFromFlags);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--new-type',
        'ftp',
        '--config-file',
        './ftp.json',
      ]);

      expect(ftpSpy).toHaveBeenCalledOnce();
      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({ strategy: 'relocate', newType: 'ftp' }),
      );
    });

    it('CI: --new-type equal to current type does not set newType', async () => {
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--new-type',
        'local',
        '--config-file',
        './new.json',
      ]);

      const call = mockRemoveProvider.mock.calls[0][2];
      expect(call).not.toHaveProperty('newType');
    });

    it('CI: aborts when adapter validateConfig returns errors', async () => {
      vi.mocked(LocalFsProvider.prototype.validateConfig).mockReturnValueOnce([
        'path must be absolute',
      ]);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      const result = await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--config-file',
        './bad.json',
      ]);

      expect(result).toBe('abort');
      expect(mockRemoveProvider).not.toHaveBeenCalled();
      expect(
        capture.errors.some((e) => e.includes('path must be absolute')),
      ).toBe(true);
    });

    it('CI: aborts when --new-type references unknown adapter', async () => {
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      const result = await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'relocate',
        '--new-type',
        'no-such-type',
      ]);

      expect(result).toBe('abort');
      expect(mockRemoveProvider).not.toHaveBeenCalled();
    });

    it('interactive: keep current type -> configureInteractive on current type', async () => {
      const interactiveSpy = vi.mocked(
        LocalFsProvider.prototype.configureInteractive,
      );
      mockReadConfig.mockResolvedValue(makeConfig() as never);
      mockPrompt
        .mockResolvedValueOnce({ strategy: 'relocate' } as never)
        .mockResolvedValueOnce({ change: false } as never); // keep type

      await runCmd(['provider', 'remove', 'dysk-1']);

      expect(interactiveSpy).toHaveBeenCalledOnce();
      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({
          strategy: 'relocate',
          newConnectionConfig: { path: '/adapter/int' },
        }),
      );
      const call = mockRemoveProvider.mock.calls[0][2];
      expect(call).not.toHaveProperty('newType');
    });

    it('interactive: change type -> rawlist -> configureInteractive on new type', async () => {
      const ftpInteractiveSpy = vi.mocked(
        FtpProvider.prototype.configureInteractive,
      );
      mockReadConfig.mockResolvedValue(makeConfig() as never);
      mockPrompt
        .mockResolvedValueOnce({ strategy: 'relocate' } as never)
        .mockResolvedValueOnce({ change: true } as never)
        .mockResolvedValueOnce({ newType: 'ftp' } as never);

      await runCmd(['provider', 'remove', 'dysk-1']);

      expect(ftpInteractiveSpy).toHaveBeenCalledOnce();
      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({ strategy: 'relocate', newType: 'ftp' }),
      );
    });
  });

  // ─── Strategia: rebuild ───────────────────────────────────────────────────

  describe('rebuild strategy', () => {
    beforeEach(() => {
      vi.spyOn(
        LocalFsProvider.prototype,
        'configureFromFlags',
      ).mockResolvedValue({ path: '/adapter/rebuild' });
      vi.spyOn(
        LocalFsProvider.prototype,
        'configureInteractive',
      ).mockResolvedValue({ path: '/adapter/rebuild-int' });
      vi.spyOn(LocalFsProvider.prototype, 'validateConfig').mockReturnValue([]);
    });

    it('interactive: asks for scope and existing target', async () => {
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

    it('CI: existing target id — targetProviderId resolved, no configureFromFlags call', async () => {
      const spy = vi.mocked(LocalFsProvider.prototype.configureFromFlags);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'rebuild',
        '--target',
        'dysk-2',
      ]);

      expect(spy).not.toHaveBeenCalled();
      expect(mockWriteConfig).not.toHaveBeenCalled();
      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({
          strategy: 'rebuild',
          targetProviderId: 'dysk-2',
        }),
      );
    });

    it('CI: new target id + --new-type creates provider via configureFromFlags and writes config', async () => {
      const spy = vi.mocked(LocalFsProvider.prototype.configureFromFlags);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'rebuild',
        '--target',
        'dysk-spare',
        '--new-type',
        'local',
        '--config-file',
        './spare.json',
      ]);

      expect(spy).toHaveBeenCalledOnce();
      const [input] = spy.mock.calls[0];
      expect(input.name).toBe('dysk-spare');
      expect(input.rawArgs).toEqual(['--config-file', './spare.json']);

      expect(mockWriteConfig).toHaveBeenCalledOnce();
      const [, writtenConfig] = mockWriteConfig.mock.calls[0];
      const added = writtenConfig.providers.find(
        (p: { id: string }) => p.id === 'dysk-spare',
      );
      expect(added?.type).toBe('local');
      expect(added?.config).toEqual({ path: '/adapter/rebuild' });

      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({
          strategy: 'rebuild',
          targetProviderId: 'dysk-spare',
        }),
      );
    });

    it('CI: new target id without --new-type aborts', async () => {
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      const result = await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'rebuild',
        '--target',
        'dysk-spare',
      ]);

      expect(result).toBe('abort');
      expect(mockRemoveProvider).not.toHaveBeenCalled();
      expect(mockWriteConfig).not.toHaveBeenCalled();
    });

    it('CI: new target id with invalid charset aborts', async () => {
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      const result = await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'rebuild',
        '--target',
        'bad name',
        '--new-type',
        'local',
      ]);

      expect(result).toBe('abort');
      expect(mockRemoveProvider).not.toHaveBeenCalled();
      expect(mockWriteConfig).not.toHaveBeenCalled();
    });

    it('CI: new target aborts when adapter validateConfig returns errors', async () => {
      vi.mocked(LocalFsProvider.prototype.validateConfig).mockReturnValueOnce([
        'path is required',
      ]);
      mockReadConfig.mockResolvedValue(makeConfig() as never);

      const result = await runCmd([
        'provider',
        'remove',
        'dysk-1',
        '--strategy',
        'rebuild',
        '--target',
        'dysk-spare',
        '--new-type',
        'local',
      ]);

      expect(result).toBe('abort');
      expect(mockWriteConfig).not.toHaveBeenCalled();
    });

    it('interactive new location: validates charset, prompts for type change, calls configureInteractive', async () => {
      const interactiveSpy = vi.mocked(
        LocalFsProvider.prototype.configureInteractive,
      );
      mockReadConfig.mockResolvedValue(makeConfig() as never);
      mockPrompt
        .mockResolvedValueOnce({ strategy: 'rebuild' } as never)
        .mockResolvedValueOnce({ scope: 'latest' } as never)
        .mockResolvedValueOnce({ targetId: '__new_location__' } as never)
        .mockResolvedValueOnce({ newId: 'dysk-spare' } as never)
        .mockResolvedValueOnce({ change: false } as never); // keep type = current (local)

      await runCmd(['provider', 'remove', 'dysk-1']);

      expect(interactiveSpy).toHaveBeenCalledOnce();
      expect(mockWriteConfig).toHaveBeenCalledOnce();
      const [, writtenConfig] = mockWriteConfig.mock.calls[0];
      const added = writtenConfig.providers.find(
        (p: { id: string }) => p.id === 'dysk-spare',
      );
      expect(added?.type).toBe('local');
      expect(added?.config).toEqual({ path: '/adapter/rebuild-int' });

      expect(mockRemoveProvider).toHaveBeenCalledWith(
        expect.any(String),
        'dysk-1',
        expect.objectContaining({
          strategy: 'rebuild',
          targetProviderId: 'dysk-spare',
          rebuildScope: 'latest',
        }),
      );
    });
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

  // ─── Anulowanie ───────────────────────────────────────────────────────────

  it('should cancel when __cancel__ selected in provider list', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValueOnce({ chosen: '__cancel__' } as never);

    const result = await runCmd(['provider', 'remove']);

    expect(result).toBe('ok');
    expect(mockRemoveProvider).not.toHaveBeenCalled();
    expect(
      capture.logs.some(
        (l) => l.includes('Cancelled') || l.includes('Anulowano'),
      ),
    ).toBe(true);
  });

  it('should propagate ExitPromptError on Ctrl+C during provider selection', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockRejectedValueOnce(new ExitPromptError() as never);

    const result = await runCmd(['provider', 'remove']);

    expect(result).toBe('cancelled');
    expect(mockRemoveProvider).not.toHaveBeenCalled();
  });

  // ─── Wpływ na wersje ──────────────────────────────────────────────────────

  it('should show affected versions warning when provider used in manifests', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockListVersions.mockResolvedValue([
      {
        version: 1,
        health: VersionHealth.Healthy,
        shards: [{ provider_id: 'dysk-1', shard_index: 0, path: '' }],
      },
    ] as never);
    mockPrompt.mockResolvedValue({ strategy: 'cancel' } as never);

    await runCmd(['provider', 'remove', 'dysk-1']);

    expect(capture.errors.some((l) => l.includes('dysk-1'))).toBe(true);
  });
});
