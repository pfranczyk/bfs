import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushMode } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ init: vi.fn() }));
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
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  return { ...actual, createCliProviderIO: vi.fn(() => ({ ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn(), choose: vi.fn(), info: vi.fn(), warn: vi.fn(), progress: vi.fn() })) };
});
// scanDir uses fs/promises — return empty directory so tests don't hit disk.
// --config-file path validation uses fs.access + fs.constants.
vi.mock('node:fs/promises', () => {
  const mock = { readdir: vi.fn().mockResolvedValue([]), stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 0 }), access: vi.fn().mockResolvedValue(undefined), constants: { R_OK: 4, W_OK: 2, X_OK: 1, F_OK: 0 } };
  return { default: mock, ...mock };
});

import inquirer from 'inquirer';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { init } from '../../src/vault/vault-manager.js';

const mockInit = vi.mocked(init);
const mockPrompt = vi.mocked(inquirer.prompt);

/** CI flags for a minimal valid 2/1 vault with 3 local providers. */
const ciBaseArgs = ['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3'];

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

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ vault_name: 'myvault' }));
  });

  it('CI: should pass scheme N=2 K=1 from flags', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scheme: { data_shards: 2, parity_shards: 1 } }));
  });

  it('CI: should pass providers from --provider flags', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        providers: [
          { id: 'p1', type: 'local', adapterPackage: null, config: { path: '/mnt/d1' } },
          { id: 'p2', type: 'local', adapterPackage: null, config: { path: '/mnt/d2' } },
          { id: 'p3', type: 'local', adapterPackage: null, config: { path: '/mnt/d3' } },
        ],
      }),
    );
  });

  it('CI: should enable encryption by default', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ encryption: expect.objectContaining({ enabled: true }) }));
  });

  it('CI: should disable encryption when --no-enc given', async () => {
    await runCmd([...ciBaseArgs, '--no-enc']);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ encryption: expect.objectContaining({ enabled: false }) }));
  });

  it('CI: should warn about an unencrypted backup when --no-enc given', async () => {
    await runCmd([...ciBaseArgs, '--no-enc']);

    expect(capture.errors.join('\n')).toMatch(/NOT encrypted/);
  });

  it('CI: should not warn about encryption when encryption stays enabled', async () => {
    await runCmd(ciBaseArgs);

    expect(capture.errors.join('\n')).not.toMatch(/NOT encrypted/);
  });

  it('CI: should keep encryption enabled when --enc given (no-op)', async () => {
    await runCmd([...ciBaseArgs, '--enc']);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ encryption: expect.objectContaining({ enabled: true }) }));
  });

  it('CI: should set push_mode=new_version by default', async () => {
    await runCmd(ciBaseArgs);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: PushMode.NewVersion }));
  });

  it('CI: should pass push_mode=ask when --push-mode ask given', async () => {
    await runCmd([...ciBaseArgs, '--push-mode', 'ask']);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: PushMode.Ask }));
  });

  it('CI: should pass push_mode=overwrite when --push-mode overwrite given', async () => {
    await runCmd([...ciBaseArgs, '--push-mode', 'overwrite']);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: PushMode.Overwrite }));
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
    mockInit.mockRejectedValue(new Error('Scheme requires 3 providers, configured: 2'));

    const result = await runCmd(ciBaseArgs);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('Scheme requires'))).toBe(true);
  });

  // ─── Walidacja wejścia w trybie CI (brak magii w defaults) ────────────────

  it('CI: should abort when --ci given without vault_name argument', async () => {
    const result = await runCmd(['init', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--ci mode requires backup name as positional argument'))).toBe(true);
  });

  it('CI: should abort when --data-shards is missing', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--ci mode requires --data-shards and --parity-shards'))).toBe(true);
  });

  it('CI: should abort when --parity-shards is missing', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--ci mode requires --data-shards and --parity-shards'))).toBe(true);
  });

  it('CI: should abort when --data-shards < 2', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '1', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--data-shards must be an integer >= 2'))).toBe(true);
  });

  it('CI: should abort when --parity-shards < 1', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '0', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--parity-shards must be an integer >= 1'))).toBe(true);
  });

  it('CI: should abort when --data-shards is not a number', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', 'abc', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--data-shards must be an integer >= 2'))).toBe(true);
  });

  it('CI: should abort when --provider count does not match N+K', async () => {
    const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:p1 --path /mnt/d1', '--provider', 'local:p2 --path /mnt/d2']);

    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
    expect(capture.errors.some((e) => e.includes('--ci mode requires 3'))).toBe(true);
  });

  it('CI: should NOT run any Inquirer prompt when validation fails', async () => {
    await runCmd(['init', '--ci']);

    expect(mockPrompt).not.toHaveBeenCalled();
  });

  // ─── Tryb interaktywny — prompty ──────────────────────────────────────────

  it('interactive: should ask for vault name when not given as argument', async () => {
    // When vault_name is not passed as CLI arg, inquirer is called for it
    mockPrompt
      .mockResolvedValueOnce({ name: 'interaktywny-vault' } as never) // vault_name
      .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
      .mockResolvedValueOnce({ dataShardsStr: '2', parityShardsStr: '1' } as never) // scheme
      .mockResolvedValueOnce({ id: 'p1' } as never) // provider 1 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 1 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d1' } as never) // provider 1 path
      .mockResolvedValueOnce({ id: 'p2' } as never) // provider 2 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 2 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d2' } as never) // provider 2 path
      .mockResolvedValueOnce({ id: 'p3' } as never) // provider 3 id
      .mockResolvedValueOnce({ type: 'local' } as never) // provider 3 type
      .mockResolvedValueOnce({ dirPath: '/mnt/d3' } as never) // provider 3 path
      .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never) // push_mode
      .mockResolvedValueOnce({ maxRamStr: '1024' } as never); // max_ram_mb

    await runCmd(['init']);

    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ vault_name: 'interaktywny-vault' }));
  });

  it('interactive: should NOT prompt for vault name when argument given', async () => {
    mockPrompt
      .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
      .mockResolvedValueOnce({ dataShardsStr: '2', parityShardsStr: '1' } as never) // scheme
      .mockResolvedValueOnce({ id: 'p1' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d1' } as never)
      .mockResolvedValueOnce({ id: 'p2' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d2' } as never)
      .mockResolvedValueOnce({ id: 'p3' } as never)
      .mockResolvedValueOnce({ type: 'local' } as never)
      .mockResolvedValueOnce({ dirPath: '/mnt/d3' } as never)
      .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never) // push_mode
      .mockResolvedValueOnce({ maxRamStr: '1024' } as never); // max_ram_mb

    await runCmd(['init', 'myvault']);

    // First prompt should be for encryption, not vault name
    expect(mockPrompt).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ name: 'encEnabled' })]));
    expect(mockInit).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ vault_name: 'myvault' }));
  });

  // ─── Pass-through --provider (type:name [adapter-flags]) ──────────────────
  // BFS contract: BFS only splits `type:name` off the first token and forwards
  // every remaining token verbatim as `rawArgs`. It does NOT know `--config-file`
  // or any other flag — that is the adapter's grammar.

  describe('CI: --provider pass-through grammar', () => {
    beforeEach(() => {
      vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags').mockResolvedValue({ path: '/stub' });
      vi.spyOn(LocalFsProvider.prototype, 'validateConfig').mockReturnValue([]);
    });

    it('should forward every post-head token as rawArgs (no BFS interpretation)', async () => {
      const spy = vi.mocked(LocalFsProvider.prototype.configureFromFlags);

      await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        'local:p1 --config-file ./d1.json',
        '--provider',
        'local:p2 --config-file ./d2.json',
        '--provider',
        'local:p3 --bucket mine --region us-east-1',
      ]);

      expect(spy).toHaveBeenCalledTimes(3);
      const [firstArg] = spy.mock.calls[0] ?? [];
      const [thirdArg] = spy.mock.calls[2] ?? [];
      expect(firstArg?.name).toBe('p1');
      expect(firstArg?.rawArgs).toEqual(['--config-file', './d1.json']);
      expect(thirdArg?.rawArgs).toEqual(['--bucket', 'mine', '--region', 'us-east-1']);
    });

    it('should preserve quoted values containing spaces in rawArgs', async () => {
      const spy = vi.mocked(LocalFsProvider.prototype.configureFromFlags);

      await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        "local:p1 --label 'my first disk' --config-file './configs/d1.json'",
        '--provider',
        'local:p2 --config-file ./d2.json',
        '--provider',
        'local:p3 --config-file ./d3.json',
      ]);

      const [firstArg] = spy.mock.calls[0] ?? [];
      expect(firstArg?.rawArgs).toEqual(['--label', 'my first disk', '--config-file', './configs/d1.json']);
    });

    it('should construct the provider io with workDir=rootDir', async () => {
      const createCliProviderIOSpy = vi.mocked(await import('../../src/providers/provider.js')).createCliProviderIO;

      await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        'local:p1 --config-file ./d1.json',
        '--provider',
        'local:p2 --config-file ./d2.json',
        '--provider',
        'local:p3 --config-file ./d3.json',
      ]);

      expect(createCliProviderIOSpy).toHaveBeenCalled();
      const passedWorkDir = createCliProviderIOSpy.mock.calls.at(-1)?.[0];
      expect(typeof passedWorkDir).toBe('string');
      expect(passedWorkDir?.length).toBeGreaterThan(0);
    });

    it('should abort when provider id has whitespace', async () => {
      const result = await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        "local:'my nas' --config-file ./d1.json",
        '--provider',
        'local:p2 --config-file ./d2.json',
        '--provider',
        'local:p3 --config-file ./d3.json',
      ]);

      expect(result).toBe('abort');
      expect(mockInit).not.toHaveBeenCalled();
      expect(capture.errors.some((e) => e.includes('my nas'))).toBe(true);
    });

    it('should abort when the provider reports invalid config', async () => {
      vi.mocked(LocalFsProvider.prototype.validateConfig).mockReturnValueOnce(['path must be absolute']);

      const result = await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        'local:p1 --config-file ./d1.json',
        '--provider',
        'local:p2 --config-file ./d2.json',
        '--provider',
        'local:p3 --config-file ./d3.json',
      ]);

      expect(result).toBe('abort');
      expect(mockInit).not.toHaveBeenCalled();
      expect(capture.errors.some((e) => e.includes('path must be absolute'))).toBe(true);
    });
  });

  // ─── Regression: multi-segment colon specs are rejected ──────────────────
  // The dispatcher is pass-through-only: everything after the first colon
  // in the head token is the provider id, validated against
  // ^[A-Za-z0-9._-]+$. Multi-segment forms like `local:p1:/path` or
  // `ftp:nas:host:port:user:pass:/path:false` fail because the candidate
  // id contains forbidden characters (`:`, `/`).

  describe('CI: multi-segment --provider spec is rejected', () => {
    it('should abort on a 3-segment local spec', async () => {
      const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:p1:/legacy/path', '--provider', 'local:p2 --path /mnt/d2', '--provider', 'local:p3 --path /mnt/d3']);

      expect(result).toBe('abort');
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('should abort on a colon-separated 8-segment FTP spec', async () => {
      const result = await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        'ftp:nas:host.example.com:21:user:pass:/backup:false',
        '--provider',
        'local:p2 --path /mnt/d2',
        '--provider',
        'local:p3 --path /mnt/d3',
      ]);

      expect(result).toBe('abort');
      expect(mockInit).not.toHaveBeenCalled();
    });
  });

  // ─── Duplicate provider id rejection ─────────────────────────────────────
  // bfs init rejects two --provider specs that share an id: a duplicate would
  // otherwise reach config.json, where a lookup resolves to the first entry and
  // orphans the rest (runtime-undefined at push). Guards that the CI path
  // aborts (exit≠0), init() is never called (no config is written), and the
  // colliding id is named in the error.

  describe('CI: duplicate --provider id is rejected', () => {
    it('should abort when two --provider specs share the same id', async () => {
      const result = await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:dup --path /mnt/d1', '--provider', 'local:dup --path /mnt/d2', '--provider', 'local:ok --path /mnt/d3']);

      expect(result).toBe('abort');
      expect(mockInit).not.toHaveBeenCalled();
    });

    it('should name the colliding id in the error when two --provider specs share an id', async () => {
      await runCmd(['init', 'myvault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'local:dup --path /mnt/d1', '--provider', 'local:dup --path /mnt/d2', '--provider', 'local:ok --path /mnt/d3']);

      expect(capture.errors.some((e) => e.includes('dup'))).toBe(true);
    });
  });

  // ─── Regression: inline FTP flags ─────────────────────────────────────────

  describe('CI: --provider ftp inline grammar', () => {
    it('should accept full ftp inline spec', async () => {
      await runCmd([
        'init',
        'myvault',
        '--ci',
        '--data-shards',
        '2',
        '--parity-shards',
        '1',
        '--provider',
        'local:p1 --path /mnt/d1',
        '--provider',
        'local:p2 --path /mnt/d2',
        '--provider',
        'ftp:nas --host h --port 21 --user u --password p --path /b --secure false',
      ]);

      expect(mockInit).toHaveBeenCalledTimes(1);
      const call = mockInit.mock.calls[0]?.[1];
      const ftp = call?.providers.find((p) => p.type === 'ftp');
      expect(ftp).toBeDefined();
      expect(ftp?.config).toEqual({ host: 'h', port: 21, user: 'u', password: 'p', path: '/b', secure: false });
    });
  });
});
