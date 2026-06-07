import { ExitPromptError } from '@inquirer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/recovery.js', () => ({ recover: vi.fn() }));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  return { ...actual, createCliProviderIO: vi.fn(() => ({ lang: 'en', workDir: process.cwd(), ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn(), choose: vi.fn(), info: vi.fn(), warn: vi.fn(), progress: vi.fn() })) };
});
vi.mock('inquirer', () => ({
  default: { prompt: vi.fn() },
  Separator: class {
    type = 'separator';
  },
}));
vi.mock('ora', () => ({ default: () => ({ start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), text: '' }) }));

import inquirer from 'inquirer';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { providerRegistry } from '../../src/providers/provider.js';
import { recover } from '../../src/vault/recovery.js';

const mockRecover = vi.mocked(recover);
const mockPrompt = vi.mocked(inquirer.prompt);

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
  let mockCreate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = captureConsole();
    mockRecover.mockResolvedValue(recoveryReport as never);
    // Interactive flow falls back to LocalFsProvider.configureInteractive,
    // mocked to skip the provider's own prompts. configureFromFlags is the
    // real implementation — it parses bootstrap spec tokens directly.
    vi.spyOn(LocalFsProvider.prototype, 'configureInteractive').mockResolvedValue({ path: '/mnt/usb' });
    // Replace providerRegistry.create with a spy returning a fake provider;
    // recovery only calls authenticate/setVaultName on the bootstrap provider.
    mockCreate = vi
      .spyOn(providerRegistry, 'create')
      .mockReturnValue({
        authenticate: vi.fn(),
        setVaultName: vi.fn(),
        upload: vi.fn(),
        download: vi.fn(),
        delete: vi.fn(),
        rename: vi.fn(),
        updateShardHeader: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        listVaults: vi.fn().mockResolvedValue([]),
        healthCheck: vi.fn().mockResolvedValue(true),
        configureInteractive: vi.fn().mockResolvedValue({}),
        configureFromFlags: vi.fn().mockReturnValue({}),
        validateConfig: vi.fn().mockReturnValue([]),
        describeConfig: vi.fn().mockReturnValue(''),
        getSecretFields: vi.fn().mockReturnValue([]),
        probeConnection: vi.fn(),
      } as unknown as ReturnType<typeof providerRegistry.create>);
  });

  afterEach(() => {
    capture.restore();
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  // ─── CI mode: pełna ścieżka --bootstrap ───────────────────────────────────

  it('should run without prompts when --bootstrap, --provider, --name provided', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockRecover).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ vaultName: 'my-vault' }));
  });

  it('should show rebuilt manifest count in output', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    const output = capture.logs.join('\n');
    expect(output).toContain('3');
  });

  it('should show versions table with health status', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    const output = capture.logs.join('\n');
    expect(output).toContain('Version');
    expect(output).toContain('Status');
    expect(output).toContain('Consensus');
  });

  it('should suggest bfs pull after successful recovery', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    const output = capture.logs.join('\n');
    expect(output).toContain('pull');
  });

  // ─── CI mode: parse adapter flags via configureFromFlags ──────────────────
  // Regression for the user's bug report — `bfs recovery --provider ftp
  // --path bfsuser@host/ftp/bfsuser` returned "530 Login incorrect" because
  // adapter flags never reached configureFromFlags. After the refactor,
  // bootstrap spec is parsed by parseRecoveryBootstrapSpec and the resulting
  // config is forwarded verbatim to providerRegistry.create.

  it('should parse local --path from bootstrap spec into provider config', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ config: { path: '/mnt/usb' } }), expect.anything());
  });

  it('should parse ftp adapter flags from bootstrap spec into provider config', async () => {
    await runCmd(['recovery', '--provider', 'ftp', '--name', 'my-vault', '--bootstrap', '--host nas.local --port 21 --user bob --password secret --path /storage']);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ host: 'nas.local', port: 21, user: 'bob', password: 'secret', path: '/storage', secure: false }) }), expect.anything());
  });

  // ─── CI mode: walidacja flag ─────────────────────────────────────────────

  it('should reject --bootstrap without --provider', async () => {
    const result = await runCmd(['recovery', '--bootstrap', '--path /mnt/usb', '--name', 'my-vault']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('--bootstrap requires --provider'))).toBe(true);
  });

  it('should reject --bootstrap without --name', async () => {
    const result = await runCmd(['recovery', '--provider', 'local', '--bootstrap', '--path /mnt/usb']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('--bootstrap requires --name'))).toBe(true);
  });

  it('should reject empty --bootstrap spec', async () => {
    const result = await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('Bootstrap spec is empty'))).toBe(true);
  });

  it('should reject unknown provider type', async () => {
    const result = await runCmd(['recovery', '--provider', 'made-up-type-xyz', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('Unknown provider type: "made-up-type-xyz"'))).toBe(true);
  });

  it('should surface adapter validation errors from configureFromFlags', async () => {
    // FTP requires host + path; missing host triggers ProviderError from
    // FtpProvider.configureFromFlags, surfaced as a CommandAbort.
    const result = await runCmd(['recovery', '--provider', 'ftp', '--name', 'my-vault', '--bootstrap', '--user bob --password secret']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('host') && l.toLowerCase().includes('required'))).toBe(true);
  });

  // ─── Tryb interaktywny (bez --bootstrap) ──────────────────────────────────

  it('should ask for provider type when --provider missing', async () => {
    // promptWithRawMode calls: provider type + vaultName.
    // Path is delegated to LocalFsProvider.configureInteractive (mocked).
    mockPrompt.mockResolvedValueOnce({ providerType: 'local' } as never).mockResolvedValueOnce({ vaultName: 'my-vault' } as never);

    await runCmd(['recovery']);

    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockRecover).toHaveBeenCalled();
  });

  it('should ask only for missing options when --provider is given', async () => {
    // Only vaultName goes through promptWithRawMode; path is delegated to
    // LocalFsProvider.configureInteractive (mocked).
    mockPrompt.mockResolvedValueOnce({ vaultName: 'my-vault' } as never);

    await runCmd(['recovery', '--provider', 'local']);

    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  // ─── Anulowanie ───────────────────────────────────────────────────────────

  it('should cancel when __cancel__ selected in provider type prompt', async () => {
    mockPrompt.mockResolvedValueOnce({ providerType: '__cancel__' } as never);

    const result = await runCmd(['recovery']);

    expect(result).toBe('ok');
    expect(mockRecover).not.toHaveBeenCalled();
    expect(capture.logs.some((l) => l.includes('Cancelled') || l.includes('Anulowano'))).toBe(true);
  });

  it('should propagate ExitPromptError on Ctrl+C during recovery prompt', async () => {
    mockPrompt.mockRejectedValueOnce(new ExitPromptError() as never);

    const result = await runCmd(['recovery']);

    expect(result).toBe('cancelled');
    expect(mockRecover).not.toHaveBeenCalled();
  });

  // ─── Błąd recover ────────────────────────────────────────────────────────

  it('should abort and show error when recover throws', async () => {
    mockRecover.mockRejectedValue(new Error('Nie znaleziono shardów'));

    const result = await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/bad']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('Nie znaleziono'))).toBe(true);
  });

  // ─── Vault password ───────────────────────────────────────────────────────

  it('should pass --password (vault encryption) to recover', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb', '--password', 'tajne']);

    expect(mockRecover).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ passwords: ['tajne'] }));
  });

  it('should accept multiple --password flags (variadic for multi-version)', async () => {
    await runCmd(['recovery', '--provider', 'local', '--name', 'my-vault', '--bootstrap', '--path /mnt/usb', '--password', 'one', '--password', 'two']);

    expect(mockRecover).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ passwords: ['one', 'two'] }));
  });

  // ─── --password w bootstrap nie koliduje z --password w recovery ──────────
  // Vault `--password` (recovery flag, variadic, encryption key) and FTP
  // `--password` (inside --bootstrap, single-value, login credential)
  // coexist because the latter lives inside a quoted string Commander
  // never sees as a top-level token.

  it('should keep vault --password and bootstrap --password independent', async () => {
    await runCmd(['recovery', '--provider', 'ftp', '--name', 'my-vault', '--bootstrap', '--host nas --user bob --password ftp-secret --path /a', '--password', 'vault-secret']);

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ password: 'ftp-secret' }) }), expect.anything());
    expect(mockRecover).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ passwords: ['vault-secret'] }));
  });
});
