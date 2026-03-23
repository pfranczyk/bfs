import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));
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
import { readConfig, writeConfig } from '../../src/vault/config.js';

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);
const mockPrompt = vi.mocked(inquirer.prompt);

describe('provider add', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockWriteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Brak konfiguracji ────────────────────────────────────────────────────

  it('should abort when vault config is missing', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'new-disk',
      '--type',
      'local',
      '--path',
      '/mnt/new',
    ]);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('bfs init'))).toBe(true);
  });

  // ─── Tryb CI ──────────────────────────────────────────────────────────────

  it('CI: should add provider and write updated config', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    expect(
      writtenConfig.providers.some((p: { id: string }) => p.id === 'dysk-4'),
    ).toBe(true);
  });

  it('CI: should increment parity_shards by 1 after adding provider (pipeline krok 6)', async () => {
    // Pipeline: new provider = dodatkowy parity shard; data_shards bez zmian
    mockReadConfig.mockResolvedValue(makeConfig() as never); // starts with parity_shards: 1

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    expect(writtenConfig.scheme.parity_shards).toBe(2); // 1 + 1
    expect(writtenConfig.scheme.data_shards).toBe(2); // unchanged
  });

  it('CI: should save new provider config with correct type and path', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'nas',
      '--type',
      'local',
      '--path',
      '/mnt/nas',
    ]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find(
      (p: { id: string }) => p.id === 'nas',
    );
    expect(added).toMatchObject({
      id: 'nas',
      type: 'local',
      config: { path: '/mnt/nas' },
    });
  });

  it('CI: should show success message with provider id and new scheme (pipeline krok 8)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    const output = capture.logs.join('\n');
    expect(output).toContain('dysk-4');
    expect(output).toContain('push');
  });

  it('CI: should suggest bfs push in success message', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    expect(capture.logs.some((l) => l.includes('push'))).toBe(true);
  });

  it('CI: should skip all inquirer prompts in CI mode', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  // ─── Walidacja CI ────────────────────────────────────────────────────────

  it('CI: should abort when --id is missing', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd([
      'provider',
      'add',
      '--ci',
      '--type',
      'local',
      '--path',
      '/mnt/d4',
    ]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('CI: should abort when --path is missing for type=local', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-4',
      '--type',
      'local',
    ]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('CI: should abort when provider id already exists', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // has dysk-1, dysk-2, dysk-3

    const result = await runCmd([
      'provider',
      'add',
      '--ci',
      '--id',
      'dysk-1',
      '--type',
      'local',
      '--path',
      '/mnt/d1',
    ]);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('dysk-1'))).toBe(true);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── Tryb interaktywny ────────────────────────────────────────────────────

  it('interactive: should call prompt for id, type, and path', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ id: 'dysk-4' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d4' } as never);

    await runCmd(['provider', 'add']);

    expect(mockPrompt).toHaveBeenCalledTimes(3);
    expect(mockWriteConfig).toHaveBeenCalledOnce();
  });

  it('interactive: should display current providers list before prompting', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt
      .mockResolvedValueOnce({ id: 'dysk-4' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d4' } as never);

    await runCmd(['provider', 'add']);

    // Should show warning about schema change
    expect(
      [...capture.logs, ...capture.errors].some((l) => l.includes('push')),
    ).toBe(true);
  });
});
