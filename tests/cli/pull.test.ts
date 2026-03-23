import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({
  pull: vi.fn(),
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
vi.mock('ora', () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  }),
}));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/providers/provider.js')>();
  return {
    ...actual,
    createCliProviderIO: vi.fn(() => ({
      ask: vi.fn(),
      askSecret: vi.fn().mockResolvedValue(''),
      confirm: vi.fn().mockResolvedValue(true),
      choose: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      progress: vi.fn(),
    })),
  };
});

import { pull } from '../../src/vault/vault-manager.js';

const mockPull = vi.mocked(pull);

describe('pull', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockPull.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Sukces ───────────────────────────────────────────────────────────────

  it('should call pull and print success message', async () => {
    const result = await runCmd(['pull']);

    expect(result).toBe('ok');
    expect(mockPull).toHaveBeenCalledOnce();
    expect(capture.logs.some((l) => l.includes('Files restored'))).toBe(true);
  });

  // ─── Flagi → opcje pull ───────────────────────────────────────────────────

  it('should pass version when --version flag given', async () => {
    await runCmd(['pull', '--version', '5']);

    expect(mockPull).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ version: 5 }),
    );
  });

  it('should pass force=true when --force flag given', async () => {
    await runCmd(['pull', '--force']);

    expect(mockPull).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ force: true }),
    );
  });

  it('should pass password when --password flag given', async () => {
    await runCmd(['pull', '--password', 'tajne']);

    expect(mockPull).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ password: 'tajne' }),
    );
  });

  it('should not set version when no --version flag', async () => {
    await runCmd(['pull']);

    expect(mockPull).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.objectContaining({ version: expect.anything() }),
    );
  });

  // ─── io — potwierdzenie nadpisania (pipeline krok 4 Tryb A) ───────────────

  it('should pass io with confirm for overwrite confirmation', async () => {
    // Pipeline step 4 (Mode A): "Na dysku: wersja X. Przywrócenie wersji Y nadpisze katalog."
    mockPull.mockImplementation(async (_dir, opts) => {
      const cont = await opts.io.confirm(
        'Na dysku: wersja 1. Przywrócenie wersji 2 nadpisze katalog. Kontynuować?',
      );
      expect(cont).toBe(true);
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('ok');
  });

  it('should abort pull when io.confirm returns false', async () => {
    mockPull.mockImplementation(async (_dir, opts) => {
      const cont = await opts.io.confirm('Kontynuować?');
      if (!cont) throw new Error('Pull cancelled.');
    });

    // Override createCliProviderIO mock to return false for confirm
    const { createCliProviderIO } = await import(
      '../../src/providers/provider.js'
    );
    vi.mocked(createCliProviderIO).mockReturnValueOnce({
      ask: vi.fn(),
      askSecret: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      choose: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      progress: vi.fn(),
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('abort');
  });

  // ─── io — hasło deszyfrowania (pipeline krok 9) ───────────────────────────

  it('should pass io with askSecret for decryption password prompt', async () => {
    // Pipeline step 9: "poproś o hasło → deriveKey → decryptBlob"
    mockPull.mockImplementation(async (_dir, opts) => {
      const pw = await opts.io.askSecret('Podaj hasło deszyfrowania:');
      expect(pw).toBe('');
    });

    const result = await runCmd(['pull']);
    expect(result).toBe('ok');
  });

  // ─── io.warn wrapper ──────────────────────────────────────────────────────

  it('should route io.warn through to underlying io.warn', async () => {
    const warnMock = vi.fn();
    const { createCliProviderIO } = await import(
      '../../src/providers/provider.js'
    );
    vi.mocked(createCliProviderIO).mockReturnValueOnce({
      ask: vi.fn(),
      askSecret: vi.fn().mockResolvedValue(''),
      confirm: vi.fn().mockResolvedValue(true),
      choose: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
      progress: vi.fn(),
    });

    mockPull.mockImplementation(async (_dir, opts) => {
      opts.io.warn('Shard 2 unavailable — skipping');
    });

    const result = await runCmd(['pull']);

    expect(result).toBe('ok');
    expect(warnMock).toHaveBeenCalledWith('Shard 2 unavailable — skipping');
  });

  // ─── Odrzucenie usuniętych opcji ──────────────────────────────────────────

  it('should reject unknown --host option', async () => {
    const result = await runCmd(['pull', '--host', '192.168.1.10']);
    expect(result).toBe('commander');
  });

  it('should reject unknown --user option', async () => {
    const result = await runCmd(['pull', '--user', 'alice']);
    expect(result).toBe('commander');
  });

  // ─── Błąd pull ────────────────────────────────────────────────────────────

  it('should abort and print error when pull throws', async () => {
    mockPull.mockRejectedValue(new Error('Za mało shardów'));

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('Za mało shardów'))).toBe(
      true,
    );
  });

  it('should abort when vault config is missing', async () => {
    mockPull.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['pull']);

    expect(result).toBe('abort');
    expect(
      capture.errors.some((e) => e.includes('No vault config found')),
    ).toBe(true);
  });
});
