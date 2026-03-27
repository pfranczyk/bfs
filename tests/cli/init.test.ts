import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushMode } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({
  init: vi.fn(),
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
// scanDir uses fs/promises — return empty directory so tests don't hit disk
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 0 }),
  },
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 0 }),
}));

import inquirer from 'inquirer';
import { init } from '../../src/vault/vault-manager.js';

const mockInit = vi.mocked(init);
const mockPrompt = vi.mocked(inquirer.prompt);

/** CI flags for a minimal valid 2/1 vault with 3 local providers. */
const ciBaseArgs = [
  'init',
  'myvault',
  '--ci',
  '--data-shards',
  '2',
  '--parity-shards',
  '1',
  '--provider',
  'local:p1:/mnt/d1',
  '--provider',
  'local:p2:/mnt/d2',
  '--provider',
  'local:p3:/mnt/d3',
];

describe('init', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Tryb CI — podstawowy ─────────────────────────────────────────────────

  it('CI: should call init with vault_name from argument', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ vault_name: 'myvault' }),
    );
  });

  it('CI: should pass scheme N=2 K=1 from flags', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        scheme: { data_shards: 2, parity_shards: 1 },
      }),
    );
  });

  it('CI: should pass providers from --provider flags', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        providers: [
          { id: 'p1', type: 'local', config: { path: '/mnt/d1' } },
          { id: 'p2', type: 'local', config: { path: '/mnt/d2' } },
          { id: 'p3', type: 'local', config: { path: '/mnt/d3' } },
        ],
      }),
    );
  });

  it('CI: should set encryption.enabled=false by default', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        encryption: expect.objectContaining({ enabled: false }),
      }),
    );
  });

  it('CI: should set encryption.enabled=true when --enc given', async () => {
    await runCmd([...ciBaseArgs, '--enc']);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        encryption: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it('CI: should set push_mode=new_version by default', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ push_mode: PushMode.NewVersion }),
    );
  });

  it('CI: should pass push_mode=ask when --push-mode ask given', async () => {
    await runCmd([...ciBaseArgs, '--push-mode', 'ask']);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ push_mode: PushMode.Ask }),
    );
  });

  it('CI: should pass push_mode=overwrite when --push-mode overwrite given', async () => {
    await runCmd([...ciBaseArgs, '--push-mode', 'overwrite']);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ push_mode: PushMode.Overwrite }),
    );
  });

  it('CI: should abort when --push-mode is invalid', async () => {
    const result = await runCmd([...ciBaseArgs, '--push-mode', 'bad']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
  });

  it('CI: should skip all inquirer prompts', async () => {
    await runCmd(ciBaseArgs);

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('CI: should show success message with vault name', async () => {
    await runCmd(ciBaseArgs);

    const output = capture.logs.join('\n');
    expect(output).toContain('myvault');
    expect(output).toContain('push');
  });

  // ─── Błąd init ────────────────────────────────────────────────────────────

  it('CI: should abort when init throws', async () => {
    mockInit.mockRejectedValue(
      new Error('Scheme requires 3 providers, configured: 2'),
    );

    const result = await runCmd(ciBaseArgs);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('Scheme requires'))).toBe(
      true,
    );
  });

  // ─── Tryb interaktywny — prompty ──────────────────────────────────────────

  it('interactive: should ask for vault name when not given as argument', async () => {
    // When vault_name is not passed as CLI arg, inquirer is called for it
    mockPrompt
      .mockResolvedValueOnce({ name: 'interaktywny-vault' } as never) // vault_name
      .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
      .mockResolvedValueOnce({
        dataShardsStr: '2',
        parityShardsStr: '1',
      } as never) // scheme
      .mockResolvedValueOnce({ id: 'p1' } as never) // provider 1 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 1 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d1' } as never) // provider 1 path
      .mockResolvedValueOnce({ id: 'p2' } as never) // provider 2 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 2 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d2' } as never) // provider 2 path
      .mockResolvedValueOnce({ id: 'p3' } as never) // provider 3 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 3 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d3' } as never) // provider 3 path
      .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never); // push_mode

    await runCmd(['init']);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ vault_name: 'interaktywny-vault' }),
    );
  });

  it('interactive: should NOT prompt for vault name when argument given', async () => {
    mockPrompt
      .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
      .mockResolvedValueOnce({
        dataShardsStr: '2',
        parityShardsStr: '1',
      } as never) // scheme
      .mockResolvedValueOnce({ id: 'p1' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d1' } as never)
      .mockResolvedValueOnce({ id: 'p2' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d2' } as never)
      .mockResolvedValueOnce({ id: 'p3' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d3' } as never)
      .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never);

    await runCmd(['init', 'myvault']);

    // First prompt should be for encryption, not vault name
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'encEnabled' })]),
    );
    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ vault_name: 'myvault' }),
    );
  });
});
