import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LockConcurrentActiveError,
  LockPartialStatePushError,
  PushCacheNoLockError,
  PushSkippedError,
} from '../../src/core/errors.js';
import type { PushResult } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

function okResult(overrides: Partial<PushResult> = {}): PushResult {
  return {
    version: 1,
    file_count: 2,
    total_size: 100,
    skipped: [],
    uploaded_count: 3,
    failed: [],
    health: VersionHealth.Healthy,
    ...overrides,
  };
}

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

  it('should call push and print healthy completion message with shard count', async () => {
    mockPush.mockResolvedValue(okResult());

    const result = await runCmd(['push']);

    expect(result).toBe('ok');
    expect(mockPush).toHaveBeenCalledOnce();
    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ io: expect.any(Object) }),
    );
    // Format from i18n `push_completed_healthy`: "version N healthy (X of Y uploaded)".
    expect(capture.logs.some((l) => /healthy.*3 of 3 uploaded/i.test(l))).toBe(
      true,
    );
  });

  it('should pass mode=new_version when --new flag used', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd(['push', '--new']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: PushMode.NewVersion }),
    );
  });

  it('should pass mode=overwrite when --overwrite flag used', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd(['push', '--overwrite']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mode: PushMode.Overwrite }),
    );
  });

  it('should pass password option when --password flag used', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd(['push', '--password', 'secret123']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ password: 'secret123' }),
    );
  });

  it('should not set mode when no flags given', async () => {
    mockPush.mockResolvedValue(okResult());

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
    mockPush.mockResolvedValue(okResult());

    await runCmd(['push', '--cache']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ fromCache: true }),
    );
  });

  it('should pass cacheDir when --cache-dir flag given', async () => {
    mockPush.mockResolvedValue(okResult({ file_count: 0, total_size: 0 }));

    await runCmd(['push', '--cache-dir', '/custom/cache']);

    expect(mockPush).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cacheDir: '/custom/cache' }),
    );
  });

  // ─── --cwd × cache flows ──────────────────────────────────────────────────
  // Guard against regressions where any path in the push pipeline silently
  // falls back to process.cwd() instead of respecting `--cwd`. The cache
  // dir, push.lock, push.blob.pending and shard files all live under
  // rootDir, so passing `--cwd` must drive every one of them.

  it('should pass --cwd value as rootDir to push()', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd(['--cwd', '/some/vault', 'push']);

    expect(mockPush).toHaveBeenCalledWith(
      path.resolve('/some/vault'),
      expect.anything(),
    );
  });

  it('should combine --cwd with --cache so resume reads cache from the cwd vault', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd(['--cwd', '/some/vault', 'push', '--cache']);

    expect(mockPush).toHaveBeenCalledWith(
      path.resolve('/some/vault'),
      expect.objectContaining({ fromCache: true }),
    );
  });

  it('should let --cache-dir override the default while --cwd still drives rootDir', async () => {
    mockPush.mockResolvedValue(okResult());

    await runCmd([
      '--cwd',
      '/some/vault',
      'push',
      '--cache-dir',
      '/custom/cache',
    ]);

    expect(mockPush).toHaveBeenCalledWith(
      path.resolve('/some/vault'),
      expect.objectContaining({ cacheDir: '/custom/cache' }),
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
      return okResult({ file_count: 0, total_size: 0 });
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
      return okResult({ file_count: 0, total_size: 0 });
    });

    const result = await runCmd(['push']);
    expect(result).toBe('ok');
  });

  it('should call io.askSecret when push uses encryption password prompt', async () => {
    mockPrompt.mockResolvedValue({ value: 'mypassword' } as never);
    mockPush.mockImplementation(async (_dir, opts) => {
      const pw = await opts.io.askSecret('Podaj hasło szyfrowania:');
      expect(pw).toBe('mypassword');
      return okResult({ file_count: 0, total_size: 0 });
    });

    const result = await runCmd(['push']);
    expect(result).toBe('ok');
    expect(mockPrompt).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: 'password', name: 'value' }),
      ]),
    );
  });

  // ─── Health-based result dispatch ─────────────────────────────────────────

  it('should warn and abort when health is degraded', async () => {
    mockPush.mockResolvedValue(
      okResult({
        version: 7,
        health: VersionHealth.Degraded,
        uploaded_count: 2,
        failed: [
          {
            shard_index: 2,
            provider_id: 'p2',
            reason: 'auth_failed',
            detail: '530 Login incorrect',
            attempted_at: '2026-05-25T17:00:00Z',
          },
        ],
      }),
    );

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    // i18n `push_partial_degraded`: "push partial, version 7 degraded (2 of 3 uploaded). ..."
    expect(
      capture.errors.some((e) => /version 7 degraded.*2 of 3/i.test(e)),
    ).toBe(true);
  });

  it('should error and abort when health is damaged', async () => {
    mockPush.mockResolvedValue(
      okResult({
        version: 9,
        health: VersionHealth.Damaged,
        uploaded_count: 1,
        failed: [
          {
            shard_index: 1,
            provider_id: 'p1',
            reason: 'network_error',
            detail: 'ECONNREFUSED',
            attempted_at: '2026-05-25T17:00:00Z',
          },
          {
            shard_index: 2,
            provider_id: 'p2',
            reason: 'network_error',
            detail: 'ETIMEDOUT',
            attempted_at: '2026-05-25T17:00:00Z',
          },
        ],
      }),
    );

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    // i18n `push_damaged`: "push damaged, version 9 not recoverable (1 of 3 required). Run `bfs prune --version 9` ..."
    expect(
      capture.errors.some((e) => /version 9 not recoverable.*1 of 3/i.test(e)),
    ).toBe(true);
    expect(capture.errors.some((e) => /bfs prune --version 9/.test(e))).toBe(
      true,
    );
  });

  it('should print PushCacheNoLockError message with missing files list', async () => {
    mockPush.mockRejectedValue(
      new PushCacheNoLockError([
        '.bfs/push.lock',
        '.bfs/cache/push.blob.pending',
      ]),
    );

    const result = await runCmd(['push', '--cache']);

    expect(result).toBe('abort');
    expect(
      capture.errors.some((e) =>
        /missing: .bfs\/push\.lock, .bfs\/cache\/push\.blob\.pending/.test(e),
      ),
    ).toBe(true);
  });

  it('should print LockConcurrentActiveError message with PID and timestamp', async () => {
    mockPush.mockRejectedValue(
      new LockConcurrentActiveError('push', 12345, '2026-05-25T17:00:00Z'),
    );

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    // i18n `lock_concurrent_active`: "another push in progress (PID 12345, started 2026-05-25T17:00:00Z)"
    expect(
      capture.errors.some((e) =>
        /another push in progress.*PID 12345.*2026-05-25T17:00:00Z/.test(e),
      ),
    ).toBe(true);
  });

  it('should print LockPartialStatePushError with clear hint', async () => {
    mockPush.mockRejectedValue(new LockPartialStatePushError(5));

    const result = await runCmd(['push']);

    expect(result).toBe('abort');
    // i18n `lock_partial_state_push`: "push.lock exists from partial-state push of version 5. Run `bfs clear` to discard the leftover state."
    expect(
      capture.errors.some((e) => /partial-state push of version 5/.test(e)),
    ).toBe(true);
    expect(capture.errors.some((e) => /bfs clear/.test(e))).toBe(true);
  });
});
