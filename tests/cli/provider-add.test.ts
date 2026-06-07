import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
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
import { FtpProvider } from '../../src/providers/ftp.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);
const mockPrompt = vi.mocked(inquirer.prompt);

async function writeConfigFile(obj: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-add-cfg-'));
  const file = path.join(dir, 'cfg.json');
  await fs.writeFile(file, JSON.stringify(obj), 'utf8');
  return file;
}

describe('provider add', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockWriteConfig.mockResolvedValue(undefined);
    // Unit tests — skip real fs probe and interactive path prompt.
    // Integration of probeConnection + configureInteractive is covered by
    // tests/providers/local-fs.test.ts.
    vi.spyOn(LocalFsProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
    vi.spyOn(LocalFsProvider.prototype, 'configureInteractive').mockResolvedValue({ path: '/mnt/d4' });
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ─── Brak konfiguracji ────────────────────────────────────────────────────

  it('should abort when vault config is missing', async () => {
    mockReadConfig.mockResolvedValue(null);

    const cfg = await writeConfigFile({ path: '/mnt/new' });
    const result = await runCmd(['provider', 'add', '--ci', '--name', 'new-disk', '--type', 'local', '--config-file', cfg]);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('bfs init'))).toBe(true);
  });

  // ─── Tryb CI ──────────────────────────────────────────────────────────────

  it('CI: should add provider and write updated config', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/d4' });

    await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local', '--config-file', cfg]);

    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    expect(writtenConfig.providers.some((p: { id: string }) => p.id === 'dysk-4')).toBe(true);
  });

  it('CI: should increment parity_shards by 1 after adding provider (pipeline krok 6)', async () => {
    // Pipeline: new provider = dodatkowy parity shard; data_shards bez zmian
    mockReadConfig.mockResolvedValue(makeConfig() as never); // starts with parity_shards: 1
    const cfg = await writeConfigFile({ path: '/mnt/d4' });

    await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local', '--config-file', cfg]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    expect(writtenConfig.scheme.parity_shards).toBe(2); // 1 + 1
    expect(writtenConfig.scheme.data_shards).toBe(2); // unchanged
  });

  it('CI: should save new provider config with correct type and path', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/nas' });

    await runCmd(['provider', 'add', '--ci', '--name', 'nas', '--type', 'local', '--config-file', cfg]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'nas');
    expect(added).toMatchObject({ id: 'nas', type: 'local', adapterPackage: null, config: { path: '/mnt/nas' } });
  });

  it('CI: should default local path to ~/.bfs-local/<name> when --config-file is omitted', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'add', '--ci', '--name', 'default-local', '--type', 'local']);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'default-local');
    expect(added).toBeDefined();
    expect(added?.config.path).toBe(path.join(os.homedir(), '.bfs-local', 'default-local'));
  });

  it('CI: should show success message with provider name and new scheme (pipeline krok 8)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local']);

    const output = capture.logs.join('\n');
    expect(output).toContain('dysk-4');
    expect(output).toContain('push');
  });

  it('CI: should suggest bfs push in success message', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local']);

    expect(capture.logs.some((l) => l.includes('push'))).toBe(true);
  });

  it('CI: should skip all inquirer prompts in CI mode', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local']);

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it('CI: should forward unknown flags to provider rawArgs without erroring', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const spy = vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');

    await runCmd(['provider', 'add', '--ci', '--name', 'cloud', '--type', 'local', '--private-key', '/home/alice/.ssh/id_rsa', '--passphrase-env', 'SECRET']);

    expect(spy).toHaveBeenCalledOnce();
    const input = spy.mock.calls[0]?.[0];
    expect(input?.name).toBe('cloud');
    expect(input?.rawArgs).toEqual(['--private-key', '/home/alice/.ssh/id_rsa', '--passphrase-env', 'SECRET']);
  });

  it('CI: should abort when --config-file path is not readable', async () => {
    // After the pass-through refactor BFS itself does not inspect
    // --config-file; the LocalFS adapter reads the JSON and surfaces the
    // unreadable-file error. The command should still abort and leave
    // the config untouched.
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4', '--type', 'local', '--config-file', path.join(os.tmpdir(), 'this-does-not-exist-bfs-test.json')]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── --config-file: rozwiązywanie ścieżki (provider używa io.workDir) ─────

  it('CI: should let the provider resolve relative --config-file against io.workDir', async () => {
    // BFS exposes its working directory on `io.workDir`; the LocalFS
    // adapter uses that to resolve a relative --config-file path. The
    // combined contract must produce the same config as an absolute path.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-add-rel-'));
    const abs = path.join(dir, 'relcfg.json');
    await fs.writeFile(abs, JSON.stringify({ path: '/mnt/rel' }), 'utf8');

    const fromFlagsSpy = vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');

    const oldCwd = process.cwd();
    process.chdir(dir);
    try {
      await runCmd(['provider', 'add', '--ci', '--name', 'rel-disk', '--type', 'local', '--config-file', 'relcfg.json']);
    } finally {
      process.chdir(oldCwd);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    expect(fromFlagsSpy).toHaveBeenCalledOnce();
    const input = fromFlagsSpy.mock.calls[0]?.[0];
    expect(input?.rawArgs).toEqual(['--config-file', 'relcfg.json']);

    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'rel-disk');
    expect(added?.config).toEqual({ path: '/mnt/rel' });
  });

  it('CI: should treat empty --config-file "" as omitted', async () => {
    // Commander leaves an explicit --config-file "" as empty string. The CLI
    // guard (length > 0) must treat it the same as missing flag — i.e. let
    // the provider fall back to its default (no readability check fires).
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'empty-flag', '--type', 'local', '--config-file', '']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'empty-flag');
    expect(added?.config.path).toBe(path.join(os.homedir(), '.bfs-local', 'empty-flag'));
  });

  // ─── --config-file: propagacja danych do writeConfig ──────────────────────

  it('CI: should persist path parsed from --config-file into saved provider config', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    // Restore real configureFromFlags so the JSON is actually read + parsed.
    vi.mocked(LocalFsProvider.prototype.configureInteractive).mockRestore?.();
    vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');
    const cfg = await writeConfigFile({ path: '/mnt/from-file' });

    await runCmd(['provider', 'add', '--ci', '--name', 'from-file', '--type', 'local', '--config-file', cfg]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'from-file');
    expect(added?.config).toEqual({ path: '/mnt/from-file' });
  });

  it('CI: should abort with human-readable error when --config-file JSON fails provider validation', async () => {
    // Local adapter requires a non-empty "path". An object literal {} should
    // bubble up as "Configuration failed: …" from the CLI wrapper instead of
    // silently writing a broken provider config.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    vi.mocked(LocalFsProvider.prototype.configureInteractive).mockRestore?.();
    vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');
    const cfg = await writeConfigFile({});

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'bad-json', '--type', 'local', '--config-file', cfg]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('Configuration failed'))).toBe(true);
  });

  it('CI: should abort with human-readable error when --config-file is not valid JSON', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    vi.mocked(LocalFsProvider.prototype.configureInteractive).mockRestore?.();
    vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-add-cfg-'));
    const file = path.join(dir, 'cfg.json');
    await fs.writeFile(file, '{not-json', 'utf8');

    try {
      const result = await runCmd(['provider', 'add', '--ci', '--name', 'garbage', '--type', 'local', '--config-file', file]);

      expect(result).toBe('abort');
      expect(mockWriteConfig).not.toHaveBeenCalled();
      expect(capture.errors.some((e) => e.includes('Configuration failed'))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── --config-file: FTP provider end-to-end (CLI layer) ──────────────────

  it('CI: should load FTP provider config from --config-file and persist it', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    // FTP probeConnection would try a real TCP connection — mock it out.
    vi.spyOn(FtpProvider.prototype, 'probeConnection').mockResolvedValue(undefined);

    const cfg = await writeConfigFile({ host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true });

    await runCmd(['provider', 'add', '--ci', '--name', 'ftp-remote', '--type', 'ftp', '--config-file', cfg]);

    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const added = writtenConfig.providers.find((p: { id: string }) => p.id === 'ftp-remote');
    expect(added).toMatchObject({ id: 'ftp-remote', type: 'ftp', config: { host: 'ftp.example.com', port: 2121, user: 'alice', password: 'secret', path: '/backup', secure: true } });
  });

  it('CI: should abort when FTP --type provider is invoked without --config-file', async () => {
    // FTP adapter requires --config-file; without it configureFromFlags throws
    // ProviderError immediately. CLI must surface this as abort, not crash.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    vi.spyOn(FtpProvider.prototype, 'probeConnection').mockResolvedValue(undefined);

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'ftp-no-file', '--type', 'ftp']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('Configuration failed'))).toBe(true);
  });

  // ─── Walidacja CI ────────────────────────────────────────────────────────

  it('CI: should abort when --name is missing', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'add', '--ci', '--type', 'local']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('CI: should abort when --type is missing', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'dysk-4']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('CI: should abort when provider name already exists', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // has dysk-1, dysk-2, dysk-3

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'dysk-1', '--type', 'local']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('dysk-1'))).toBe(true);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── Tryb interaktywny ────────────────────────────────────────────────────

  it('interactive: should prompt for name and type (path goes through configureInteractive)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValueOnce({ name: 'dysk-4' } as never).mockResolvedValueOnce({ type: 'local' } as never);

    await runCmd(['provider', 'add']);

    // Only name + type go through promptWithRawMode; path is delegated to
    // LocalFsProvider.configureInteractive (mocked above).
    expect(mockPrompt).toHaveBeenCalledTimes(2);
    expect(mockWriteConfig).toHaveBeenCalledOnce();
  });

  it('interactive: should display current providers list before prompting', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValueOnce({ name: 'dysk-4' } as never).mockResolvedValueOnce({ type: 'local' } as never);

    await runCmd(['provider', 'add']);

    // Should show warning about schema change
    expect([...capture.logs, ...capture.errors].some((l) => l.includes('push'))).toBe(true);
  });

  // ─── Walidacja charset nazwy providera ────────────────────────────────────

  it('CI: should abort when --name contains whitespace', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/d4' });

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'my nas', '--type', 'local', '--config-file', cfg]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('"my nas"') && e.includes('-'))).toBe(true);
  });

  it('CI: should abort when --name contains a colon', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/d4' });

    const result = await runCmd(['provider', 'add', '--ci', '--name', 'nas:1', '--type', 'local', '--config-file', cfg]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });
});
