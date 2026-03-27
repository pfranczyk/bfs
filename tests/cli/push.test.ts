import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushSkippedError } from '../../src/core/errors.js';
import { PushMode } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({
  push: vi.fn(),
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
import { push } from '../../src/vault/vault-manager.js';

const mockPush = vi.mocked(push);
const mockPrompt = vi.mocked(inquirer.prompt);

describe('push', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Sukces ───────────────────────────────────────────────────────────────

  it('should call push and print success message', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    const result = await runCmd(['push']);

    expect(result).toBe('ok');
    expect(mockPush).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ io: expect.any(Object) }),
    );
    expect(capture.logs.some((l) => l.includes('Backup uploaded'))).toBe(true);
  });

  it('should pass mode=new_version when --new flag used', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    await runCmd(['push', '--new']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: PushMode.NewVersion }),
    );
  });

  it('should pass mode=overwrite when --overwrite flag used', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    await runCmd(['push', '--overwrite']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: PushMode.Overwrite }),
    );
  });

  it('should pass password option when --password flag used', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    await runCmd(['push', '--password', 'secret123']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ password: 'secret123' }),
    );
  });

  it('should not set mode when no flags given', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    await runCmd(['push']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ mode: expect.anything() }),
    );
  });

  // ─── Błędy ────────────────────────────────────────────────────────────────

  it('should abort and print error when push throws', async () => {
    mockPush.mockRejectedValue(new Error('Brak konfiguracji'));

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('Brak konfiguracji'))).toBe(
      true,
    );
  });

  it('should abort when push throws BfsError about missing providers', async () => {
    mockPush.mockRejectedValue(new Error('Scheme requires 3 providers'));

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
  });

  it('should show skipped file list and cache hint when PushSkippedError is thrown', async () => {
    const cachePath = '/vault/.bfs/cache/push.blob.pending';
    mockPush.mockRejectedValue(
      new PushSkippedError(
        [
          { path: 'secret.key', reason: 'EACCES: permission denied' },
          { path: 'locked.db', reason: 'EACCES: permission denied' },
        ],
        cachePath,
      ),
    );

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('could not be read'))).toBe(
      true,
    );
    expect(capture.logs.some((l) => l.includes('push --cache'))).toBe(true);
  });

  it('should pass fromCache=true when --cache flag given', async () => {
    mockPush.mockResolvedValue({
      version: 1,
      file_count: 2,
      total_size: 100,
      skipped: [],
    });

    await runCmd(['push', '--cache']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fromCache: true }),
    );
  });

  // ─── Prompt ask (push_mode=ask) ───────────────────────────────────────────

  it('should call io.choose when push_mode=ask and pass user answer to push', async () => {
    // push() itself calls io.choose internally — we verify the io passed
    // has a working choose() method backed by Inquirer
    mockPrompt.mockResolvedValue({ value: 'New version (v1)' } as never);
    mockPush.mockImplementation(async (_dir, opts) => {
      // Simulate vault-manager calling io.choose for push_mode=ask
      const choice = await opts.io.choose(
        'Create new version v1 or overwrite v0?',
        ['New version (v1)', 'Overwrite (v0)'],
      );
      expect(choice).toBe('New version (v1)');
      return { version: 1, file_count: 0, total_size: 0, skipped: [] };
    });

    const result = await runCmd(['push']);

    expect(result).toBe('ok');
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'rawlist', name: 'value' }),
      ]),
    );
  });

  it('should call io.choose and select overwrite when user picks second option', async () => {
    mockPrompt.mockResolvedValue({ value: 'Overwrite (v0)' } as never);
    mockPush.mockImplementation(async (_dir, opts) => {
      const choice = await opts.io.choose(
        'Create new version v1 or overwrite v0?',
        ['New version (v1)', 'Overwrite (v0)'],
      );
      expect(choice).toBe('Overwrite (v0)');
      return { version: 1, file_count: 0, total_size: 0, skipped: [] };
    });

    const result = await runCmd(['push']);
    expect(result).toBe('ok');
  });

  it('should call io.askSecret when push uses encryption password prompt', async () => {
    mockPrompt.mockResolvedValue({ value: 'mypassword' } as never);
    mockPush.mockImplementation(async (_dir, opts) => {
      const pw = await opts.io.askSecret('Podaj hasło szyfrowania:');
      expect(pw).toBe('mypassword');
      return { version: 1, file_count: 0, total_size: 0, skipped: [] };
    });

    const result = await runCmd(['push']);
    expect(result).toBe('ok');
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'password', name: 'value' }),
      ]),
    );
  });
});
