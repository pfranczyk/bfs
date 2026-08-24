import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PullSkippedError } from '../../src/core/errors.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ pull: vi.fn() }));
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
vi.mock('ora', () => ({ default: () => ({ start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), text: '' }) }));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  return { ...actual, createCliProviderIO: vi.fn(() => ({ ask: vi.fn(), askSecret: vi.fn().mockResolvedValue(''), confirm: vi.fn().mockResolvedValue(true), choose: vi.fn(), info: vi.fn(), warn: vi.fn(), progress: vi.fn() })) };
});

import { pull } from '../../src/vault/vault-manager.js';

const mockPull = vi.mocked(pull);

describe('pull', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockPull.mockResolvedValue({ version: 1, extracted: 3, skipped: [] });
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // --- Success ---------------------------------------------------------------

  it('should call pull and print success message', async () => {
    const result = await runCmd(['pull']);

    expect(result).toBe('ok');
    expect(mockPull).toHaveBeenCalledOnce();
    expect(capture.logs.some((l) => l.includes('Files restored'))).toBe(true);
  });

  // --- Flags -> pull options ---------------------------------------------------

  it('should pass version when --version flag given', async () => {
    await runCmd(['pull', '--version', '5']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ version: 5 }));
  });

  it('should pass force=true when --force flag given', async () => {
    await runCmd(['pull', '--force']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ force: true }));
  });

  it('should pass password when --password flag given', async () => {
    await runCmd(['pull', '--password', 'tajne']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ password: 'tajne' }));
  });

  it('should not set version when no --version flag', async () => {
    await runCmd(['pull']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.not.objectContaining({ version: expect.anything() }));
  });

  // --- io - overwrite confirmation (pipeline step 4, Mode A) ---------------

  it('should pass io with confirm for overwrite confirmation', async () => {
    // Pipeline step 4 (Mode A): "On disk: version X. Restoring version Y overwrites the directory."
    mockPull.mockImplementation(async (_dir, opts) => {
      const cont = await opts.io.confirm('Na dysku: wersja 1. Przywrócenie wersji 2 nadpisze katalog. Kontynuować?');
      expect(cont).toBe(true);
      return { version: 1, extracted: 0, skipped: [] };
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('ok');
  });

  it('should end with the refusal when the password cannot be asked for', async () => {
    // A scripted restore of an encrypted backup reaches the password prompt, and
    // where nobody can answer the IO refuses instead of asking (that refusal is
    // pinned in tests/providers/cli-provider-io.test.ts). What this pins is the
    // command's half: the refusal is reported and the run ends non-zero. Left to
    // itself the prompt would never settle - the process would die mid-restore
    // and, with no exit code set, report success having written nothing.
    const refusal = new BfsError('This run asks no questions (--ci, or no terminal attached), and it needs an answer to: Enter decryption password:');
    mockPull.mockImplementation(async (_dir, opts) => {
      const io = { ...opts.io, askSecret: vi.fn().mockRejectedValue(refusal) };
      await io.askSecret('Enter decryption password:');
      return { version: 1, extracted: 0, skipped: [] };
    });

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => /asks no questions/i.test(l))).toBe(true);
  });

  it('should abort pull when io.confirm returns false', async () => {
    mockPull.mockImplementation(async (_dir, opts) => {
      const cont = await opts.io.confirm('Kontynuować?');
      if (!cont) throw new Error('Pull cancelled.');
      return { version: 1, extracted: 0, skipped: [] };
    });

    // Override createCliProviderIO mock to return false for confirm
    const { createCliProviderIO } = await import('../../src/providers/provider.js');
    vi.mocked(createCliProviderIO).mockReturnValueOnce({
      lang: 'en',
      workDir: process.cwd(),
      ask: vi.fn(),
      askSecret: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      choose: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      progress: vi.fn(),
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('abort');
  });

  // --- io - decryption password (pipeline step 9) ---------------------------

  it('should pass io with askSecret for decryption password prompt', async () => {
    // Pipeline step 9: "ask for password -> deriveKey -> decryptBlob"
    mockPull.mockImplementation(async (_dir, opts) => {
      const pw = await opts.io.askSecret('Podaj hasło deszyfrowania:');
      expect(pw).toBe('');
      return { version: 1, extracted: 0, skipped: [] };
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('ok');
  });

  // --- io.warn wrapper ------------------------------------------------------

  it('should route io.warn through to underlying io.warn', async () => {
    const warnMock = vi.fn();
    const { createCliProviderIO } = await import('../../src/providers/provider.js');
    vi.mocked(createCliProviderIO).mockReturnValueOnce({
      lang: 'en',
      workDir: process.cwd(),
      ask: vi.fn(),
      askSecret: vi.fn().mockResolvedValue(''),
      confirm: vi.fn().mockResolvedValue(true),
      choose: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      warn: warnMock,
      progress: vi.fn(),
    });

    mockPull.mockImplementation(async (_dir, opts) => {
      opts.io.warn('Shard 2 unavailable - skipping');
      return { version: 1, extracted: 0, skipped: [] };
    });

    const result = await runCmd(['pull']);

    expect(result).toBe('ok');
    expect(warnMock).toHaveBeenCalledWith('Shard 2 unavailable - skipping');
  });

  it('should pass cacheDir when --cache-dir flag given', async () => {
    await runCmd(['pull', '--cache-dir', '/custom/cache']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cacheDir: '/custom/cache' }));
  });

  // --- Rejecting removed options ------------------------------------------

  it('should reject unknown --host option', async () => {
    const result = await runCmd(['pull', '--host', '192.168.1.10']);
    expect(result).toBe('commander');
  });

  it('should reject unknown --user option', async () => {
    const result = await runCmd(['pull', '--user', 'alice']);
    expect(result).toBe('commander');
  });

  // --- PullSkippedError + --cache -------------------------------------------

  it('should show skipped file list and cache hint when PullSkippedError is thrown', async () => {
    const cachePath = '/vault/.bfs/cache/pull.blob.pending';
    mockPull.mockRejectedValue(new PullSkippedError([{ path: 'protected.cfg', reason: 'EACCES: permission denied' }], cachePath));

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('could not be written'))).toBe(true);
    expect(capture.logs.some((l) => l.includes('pull --cache'))).toBe(true);
  });

  it('should pass fromCache=true when --cache flag given', async () => {
    await runCmd(['pull', '--cache']);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ fromCache: true }));
  });

  // --- pull errors ------------------------------------------------------------

  it('should abort and print error when pull throws', async () => {
    mockPull.mockRejectedValue(new Error('Za mało shardów'));

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('Za mało shardów'))).toBe(true);
  });

  it('should abort when vault config is missing', async () => {
    mockPull.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('No vault config found'))).toBe(true);
  });
});
