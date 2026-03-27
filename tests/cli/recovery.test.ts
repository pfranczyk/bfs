import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/recovery.js', () => ({
  recover: vi.fn(),
}));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/providers/provider.js')>();
  return {
    ...actual,
    createProvider: vi.fn(() => ({
      authenticate: vi.fn(),
      setVaultName: vi.fn(),
      upload: vi.fn(),
      download: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
      listVaults: vi.fn(),
      healthCheck: vi.fn(),
    })),
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
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
  Separator: class {
    type = 'separator';
  },
}));
vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  }),
}));

import inquirer from 'inquirer';
import { createProvider } from '../../src/providers/provider.js';
import { recover } from '../../src/vault/recovery.js';

const mockRecover = vi.mocked(recover);
const mockPrompt = vi.mocked(inquirer.prompt);
const mockCreateProvider = vi.mocked(createProvider);

const recoveryReport = {
  manifests_rebuilt: 3,
  versions: [
    { version: 1, health: VersionHealth.Healthy, consensus: true },
    { version: 2, health: VersionHealth.Healthy, consensus: true },
    { version: 3, health: VersionHealth.Degraded, consensus: true },
  ],
};

describe('recovery', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockRecover.mockResolvedValue(recoveryReport as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Z pełnymi opcjami (CI mode) ──────────────────────────────────────────

  it('should run without prompts when all options provided', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockRecover).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ vaultName: 'my-vault' }),
    );
  });

  it('should show rebuilt manifest count in output', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    const output = capture.logs.join('\n');
    expect(output).toContain('3');
  });

  it('should show versions table with health status', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    const output = capture.logs.join('\n');
    expect(output).toContain('Version');
    expect(output).toContain('Status');
    expect(output).toContain('Consensus');
  });

  it('should suggest bfs pull after successful recovery', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    const output = capture.logs.join('\n');
    expect(output).toContain('pull');
  });

  // ─── Interaktywne prompty (bez opcji) ─────────────────────────────────────

  it('should ask for provider type when --provider missing', async () => {
    mockPrompt
      .mockResolvedValueOnce({ providerType: 'local' } as never)
      .mockResolvedValueOnce({ basePath: '/mnt/usb' } as never)
      .mockResolvedValueOnce({ vaultName: 'my-vault' } as never);

    await runCmd(['recovery']);

    expect(mockPrompt).toHaveBeenCalledTimes(3);
    expect(mockRecover).toHaveBeenCalled();
  });

  it('should ask only for missing options when some are provided', async () => {
    mockPrompt
      .mockResolvedValueOnce({ basePath: '/mnt/usb' } as never)
      .mockResolvedValueOnce({ vaultName: 'my-vault' } as never);

    await runCmd(['recovery', '--provider', 'local']);

    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('should not ask for any option when all three are provided', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  // ─── Błąd recover ────────────────────────────────────────────────────────

  it('should abort and show error when recover throws', async () => {
    mockRecover.mockRejectedValue(new Error('Nie znaleziono shardów'));

    const result = await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/bad',
      '--name',
      'my-vault',
    ]);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('Nie znaleziono'))).toBe(true);
  });

  // ─── parseProviderPath — lokalna ścieżka ──────────────────────────────────

  it('should pass plain path as-is for local provider', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
    ]);

    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({ config: { path: '/mnt/usb' } }),
      expect.anything(),
    );
  });

  // ─── parseProviderPath — zdalny user@host/path ─────────────────────────────

  it('should parse user@host/path into separate config fields for ssh', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'ssh',
      '--path',
      'alice@192.168.1.10/backup/',
      '--name',
      'my-vault',
    ]);

    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { user: 'alice', host: '192.168.1.10', path: '/backup/' },
      }),
      expect.anything(),
    );
  });

  it('should parse user@host/path into separate config fields for ftp', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'ftp',
      '--path',
      'bob@nas.local/storage/backups/',
      '--name',
      'docs',
    ]);

    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {
          user: 'bob',
          host: 'nas.local',
          path: '/storage/backups/',
        },
      }),
      expect.anything(),
    );
  });

  it('should set path to "/" when no path segment after host', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'ssh',
      '--path',
      'alice@192.168.1.10',
      '--name',
      'my-vault',
    ]);

    expect(mockCreateProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { user: 'alice', host: '192.168.1.10', path: '/' },
      }),
      expect.anything(),
    );
  });

  // ─── Odrzucenie usuniętych opcji ──────────────────────────────────────────

  it('should reject unknown --host option', async () => {
    const result = await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
      '--host',
      '192.168.1.10',
    ]);

    expect(result).toBe('commander');
  });

  it('should reject unknown --user option', async () => {
    const result = await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
      '--user',
      'alice',
    ]);

    expect(result).toBe('commander');
  });

  // ─── Z hasłem ─────────────────────────────────────────────────────────────

  it('should pass --password to recover', async () => {
    await runCmd([
      'recovery',
      '--provider',
      'local',
      '--path',
      '/mnt/usb',
      '--name',
      'my-vault',
      '--password',
      'tajne',
    ]);

    expect(mockRecover).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ password: 'tajne' }),
    );
  });
});
