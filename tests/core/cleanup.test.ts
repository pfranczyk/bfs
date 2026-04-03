/**
 * Tests for src/core/cleanup.ts
 *
 * The module uses module-level state (pendingFiles Set, registered flag).
 * Each test resets the module via vi.resetModules() + dynamic import to get
 * a fresh state, and spies on process.on / process.exit / fs.unlinkSync
 * before loading the module.
 */

import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CleanupModule = {
  trackFile: (filePath: string) => void;
  untrackFile: (filePath: string) => void;
};

describe('cleanup', () => {
  let trackFile: CleanupModule['trackFile'];
  let untrackFile: CleanupModule['untrackFile'];

  beforeEach(async () => {
    // Reset module state before each test so pendingFiles and registered start fresh
    vi.resetModules();
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'exit').mockImplementation(
      (_code?: string | number | null) => {
        throw new Error('process.exit called');
      },
    );
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

    const mod = (await import('../../src/core/cleanup.js')) as CleanupModule;
    trackFile = mod.trackFile;
    untrackFile = mod.untrackFile;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── trackFile ────────────────────────────────────────────────────────────

  it('should register SIGINT handler on first trackFile call', () => {
    trackFile('/tmp/file.bin');

    expect(vi.mocked(process.on)).toHaveBeenCalledWith(
      'SIGINT',
      expect.any(Function),
    );
  });

  it('should register SIGINT handler only once across multiple trackFile calls', () => {
    trackFile('/tmp/a.bin');
    trackFile('/tmp/b.bin');
    trackFile('/tmp/c.bin');

    expect(vi.mocked(process.on)).toHaveBeenCalledTimes(1);
  });

  it('should not register handler when no files are tracked', () => {
    expect(vi.mocked(process.on)).not.toHaveBeenCalled();
  });

  // ─── untrackFile ──────────────────────────────────────────────────────────

  it('should remove file from tracked set after untrackFile', () => {
    trackFile('/tmp/target.bin');
    untrackFile('/tmp/target.bin');

    // Trigger SIGINT — file should NOT be deleted
    const [[, handler]] = vi.mocked(process.on).mock.calls;
    expect(() => (handler as () => void)()).toThrow('process.exit called');

    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });

  it('should tolerate untrackFile on a file that was never tracked', () => {
    expect(() => untrackFile('/tmp/nonexistent.bin')).not.toThrow();
  });

  // ─── SIGINT handler ───────────────────────────────────────────────────────

  it('should call fs.unlinkSync for each tracked file on SIGINT', () => {
    trackFile('/tmp/a.bin');
    trackFile('/tmp/b.bin');

    const [[, handler]] = vi.mocked(process.on).mock.calls;
    expect(() => (handler as () => void)()).toThrow('process.exit called');

    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith('/tmp/a.bin');
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalledWith('/tmp/b.bin');
  });

  it('should not call fs.unlinkSync for untracked file on SIGINT', () => {
    trackFile('/tmp/tracked.bin');
    untrackFile('/tmp/tracked.bin');

    const [[, handler]] = vi.mocked(process.on).mock.calls;
    expect(() => (handler as () => void)()).toThrow('process.exit called');

    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalledWith(
      '/tmp/tracked.bin',
    );
  });

  it('should call process.exit(130) on SIGINT', () => {
    trackFile('/tmp/file.bin');

    const [[, handler]] = vi.mocked(process.on).mock.calls;
    expect(() => (handler as () => void)()).toThrow('process.exit called');

    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(130);
  });

  it('should tolerate fs.unlinkSync throwing on SIGINT (best-effort)', () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    trackFile('/tmp/missing.bin');

    const [[, handler]] = vi.mocked(process.on).mock.calls;
    // Should still reach process.exit despite unlinkSync throwing
    expect(() => (handler as () => void)()).toThrow('process.exit called');
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(130);
  });
});
