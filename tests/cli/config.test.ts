/**
 * Tests for src/cli/commands/config.ts
 *
 * Mocks readConfig/writeConfig from vault/config.js to avoid filesystem I/O.
 * Uses captureConsole() to assert on user-facing output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tFor } from '../../src/i18n/index.js';
import { captureConsole, makeConfig, runCmd, runCmdExitCode } from './_helpers.js';

vi.mock('../../src/vault/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/config.js')>();
  return { ...actual, readConfig: vi.fn(), writeConfig: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, default: { ...(actual.default as Record<string, unknown>), stat: vi.fn().mockResolvedValue({ isDirectory: () => true }) } };
});

import fsMock from 'node:fs/promises';
import { readConfig, writeConfig } from '../../src/vault/config.js';

const mockStat = vi.mocked(fsMock.stat);
const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);

describe('config', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    // Each test owns its stat queue: mockResolvedValueOnce entries that a test
    // does not consume would otherwise be answered to the next one, which
    // silently moves what a failure proves.
    mockStat.mockReset();
    mockStat.mockResolvedValue({ isDirectory: () => true } as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // --- Display (no args) ----------------------------------------------------

  it('should display current settings when no args given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/custom/cache', temp_dir: '/custom/tmp' }) as never);

    const result = await runCmd(['config']);

    expect(result).toBe('ok');
    const all = capture.logs.join('\n');
    expect(all).toContain('/custom/cache');
    expect(all).toContain('/custom/tmp');
  });

  it('should display (default) placeholder when cache_dir is null', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: null, temp_dir: null }) as never);

    await runCmd(['config']);

    const all = capture.logs.join('\n');
    expect(all).toContain('default');
  });

  it('should print error when no config found', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['config']);

    expect(result).toBe('ok');
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/no backup|brak/i);
  });

  // --- Set cache_dir --------------------------------------------------------

  it('should set cache_dir and call writeConfig when --cache-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['config', '--cache-dir', '/new/cache']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache_dir: '/new/cache' }));
  });

  it('should print config_updated on successful set', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--cache-dir', '/new/cache']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/updated|zaktualizowane/i);
  });

  // --- Set temp_dir ---------------------------------------------------------

  it('should set temp_dir and call writeConfig when --temp-dir given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config', '--temp-dir', '/custom/tmp']);

    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ temp_dir: '/custom/tmp' }));
  });

  // --- Reset cache_dir ------------------------------------------------------

  it('should reset cache_dir to null when --cache-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/old/cache' }) as never);

    const result = await runCmd(['config', '--cache-dir', '--reset']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cache_dir: null }));
  });

  it('should list the default value when a reset is performed', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/old/cache' }) as never);

    await runCmd(['config', '--cache-dir', '--reset']);

    const all = capture.logs.join('\n');
    expect(all.toLowerCase()).toMatch(/reset|default|domyśln/i);
  });

  // --- Reset temp_dir -------------------------------------------------------

  it('should reset temp_dir to null when --temp-dir --reset given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ temp_dir: '/old/tmp' }) as never);

    await runCmd(['config', '--temp-dir', '--reset']);

    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ temp_dir: null }));
  });

  // --- No writeConfig when nothing changes ----------------------------------

  it('should not call writeConfig when displaying settings (no args)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['config']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // --- Validation: reject nonexistent directories --------------------------

  it('should reject --cache-dir when parent directory does not exist', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    await runCmd(['config', '--cache-dir', 'Z:\\nonexistent\\cache']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not exist|nie istnieje/i);
  });

  it('should reject --temp-dir when parent directory does not exist', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    await runCmd(['config', '--temp-dir', 'Z:\\nonexistent\\tmp']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not exist|nie istnieje/i);
  });

  // --- Validation: the leaf, the wording and the exit code -----------------

  // `bfs config` is the only writer of cache_dir / temp_dir, and push and pull
  // are the only readers. Writer and readers share one check
  // (validateConfigDir in vault/scratch-dir.ts), so a path the readers would
  // turn away cannot be stored here - otherwise the operator learns of it one
  // push later, from a message that sends them back to this command.

  it('should reject --temp-dir when the path exists as a file', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    // parent is a directory, the leaf itself is an existing file
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    const result = await runCmd(['config', '--temp-dir', '/parent/notadir']);

    expect(result, 'a refused setting must abort, not report success').toBe('abort');
    expect(mockWriteConfig, 'a path the readers reject must not reach config.json').not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all, 'the refusal must carry the one-command fix, as push and pull do').toContain('bfs config --temp-dir');
  });

  it('should reject --cache-dir when the path exists as a file', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    const result = await runCmd(['config', '--cache-dir', '/parent/notadir']);

    expect(result, 'a refused setting must abort, not report success').toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all).toContain('bfs config --cache-dir');
  });

  it('should give a reason the operator can act on when the parent is a file, not "does not exist"', async () => {
    // The parent resolves to an existing file. "Directory does not exist" reads
    // as "create it", and creating it is exactly what cannot be done here -
    // mkdir on that path fails with ENOTDIR however many times it is tried.
    // The refusal has to name the real obstacle, or the advice sends the
    // operator in a circle.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    await runCmd(['config', '--temp-dir', '/parent-is-a-file/tmp']);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all.toLowerCase()).toMatch(/not a directory|nie jest katalogiem/i);
    expect(all.toLowerCase(), 'an obstacle that is not absence must not be reported as absence').not.toMatch(/does not exist|nie istnieje/i);
  });

  it('should exit non-zero when a directory setting is refused', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    const code = await runCmdExitCode(['config', '--temp-dir', 'Z:\\nonexistent\\tmp']);

    expect(code, 'a refusal that exits 0 cannot be told from a stored value by a script').toBe(1);
  });

  it('should accept a directory setting whose leaf does not exist yet (A/B control)', async () => {
    // The opposite side of the same check: push and pull create the leaf
    // themselves, so a missing one is not a fault and must still be stored.
    // Without this control the fix could be tightened into refusing every
    // path that is not already a directory.
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockRejectedValueOnce(new Error('ENOENT'));

    const result = await runCmd(['config', '--temp-dir', '/parent/not-yet-there']);

    expect(result).toBe('ok');
    expect(mockWriteConfig, 'a leaf BFS creates on first use must be accepted').toHaveBeenCalled();
  });

  // --- max_ram ---------------------------------------------------------------
  // The RAM limit is a whole number of MiB above zero. Auto (25% of memory) is
  // the bare flag or --reset. 0 is refused rather than read as auto: push takes
  // a stored or typed 0 as a zero budget, so accepting it here would let one
  // value mean auto in one command and a zero budget in another.

  it.each([
    ['abc', 'not a number at all'],
    ['512abc', 'a number with trailing text'],
    ['-5', 'a negative number'],
    ['0', 'zero, which push would take as a zero budget'],
    ['1.5', 'a fraction'],
    ['1e3', 'a number in exponent notation'],
    ['', 'an empty value, as from an unset variable'],
  ])('should refuse --max-ram "%s" (%s) with a non-zero exit and no write', async (value) => {
    mockReadConfig.mockResolvedValue(makeConfig({ max_ram_mb: 1024 }) as never);

    const code = await runCmdExitCode(['config', '--max-ram', value]);

    expect(code, 'a refusal that exits 0 cannot be told from a stored value by a script').toBe(1);
    expect(mockWriteConfig).not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).toContain(`--max-ram must be an integer >= 1 (MB), got "${value}".`);
    expect(all, 'a refused value must not be listed as if it had been stored').not.toMatch(/NaN MB|Settings updated/);
  });

  it('should refuse the whole command when --max-ram next to --on is invalid', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const code = await runCmdExitCode(['config', '--on', 'compress', '--max-ram', 'abc']);

    expect(code).toBe(1);
    expect(mockWriteConfig, 'compression must not be switched by a command that was refused').not.toHaveBeenCalled();
  });

  it('should store a whole --max-ram above zero (A/B control)', async () => {
    // The opposite side of the same check: without it the fix could refuse
    // every value and still pass the cases above.
    mockReadConfig.mockResolvedValue(makeConfig({ max_ram_mb: null }) as never);

    const result = await runCmd(['config', '--max-ram', '1']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ max_ram_mb: 1 }));
    expect(capture.logs.join('\n')).toMatch(/max-ram:\s+1 MB/);
  });

  it.each([
    ['en', 'Set RAM limit for encoding (MB)'],
    ['pl', 'Ustaw limit RAM do kodowania (MB)'],
  ])('should not offer 0 as auto in the --max-ram help (%s), since the command refuses it', (lang, expected) => {
    const description = tFor(lang, 'config_opt_max_ram');

    expect(description).toBe(expected);
    expect(description, 'help must not advise a value the command refuses').not.toMatch(/\b0\b/);
  });

  it('should bring --max-ram back to auto with the bare flag', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ max_ram_mb: 1024 }) as never);

    const result = await runCmd(['config', '--max-ram']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ max_ram_mb: null }));
  });

  // --- push_mode ------------------------------------------------------------

  // push_mode is chosen by the operator at `init --push-mode` and `bfs config
  // --push-mode`. Recovery records new_version, so `bfs config` is also the way
  // back to the mode a rebuilt backup had. Both flags accept the same three
  // values with the same exact-match check - push treats anything else as new_version, so
  // a value stored in another spelling would be ignored without a word.

  it.each([
    ['new_version', 'overwrite'],
    ['overwrite', 'new_version'],
    ['ask', 'new_version'],
  ])('should store push_mode "%s" when --push-mode is given', async (mode, before) => {
    mockReadConfig.mockResolvedValue(makeConfig({ push_mode: before }) as never);

    const result = await runCmd(['config', '--push-mode', mode]);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: mode }));
    expect(capture.logs.join('\n').toLowerCase()).toMatch(/updated|zaktualizowane/i);
  });

  it('should refuse an unknown --push-mode with the init wording, a non-zero exit and no write', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const code = await runCmdExitCode(['config', '--push-mode', 'sometimes']);

    expect(code, 'a refusal that exits 0 cannot be told from a stored value by a script').toBe(1);
    expect(mockWriteConfig, 'an invalid mode must not reach config.json').not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).toMatch(/Invalid --push-mode: "sometimes"|Nieprawidłowy --push-mode: "sometimes"/);
    expect(all).toContain('new_version|overwrite|ask');
  });

  it('should refuse a --push-mode spelled in another case, as init does', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const code = await runCmdExitCode(['config', '--push-mode', 'OVERWRITE']);

    expect(code).toBe(1);
    expect(mockWriteConfig, 'a value push would not recognise must not be stored').not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).toMatch(/Invalid --push-mode: "OVERWRITE"|Nieprawidłowy --push-mode: "OVERWRITE"/);
  });

  it('should show the stored push_mode when no args given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ push_mode: 'overwrite' }) as never);

    await runCmd(['config']);

    expect(capture.logs.join('\n')).toMatch(/push-mode:\s+overwrite/);
  });

  it('should store push_mode together with a directory setting in one write', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ push_mode: 'new_version' }) as never);

    const result = await runCmd(['config', '--push-mode', 'ask', '--temp-dir', '/custom/tmp']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: 'ask', temp_dir: '/custom/tmp' }));
  });

  // --reset has nothing to bring push_mode back to, so next to --push-mode it
  // has nothing to act on: the mode is stored and the directory settings stay put.
  it('should store push_mode and leave the directory settings alone when --reset is given with it', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ push_mode: 'new_version', cache_dir: '/kept/cache', temp_dir: '/kept/tmp' }) as never);

    const result = await runCmd(['config', '--reset', '--push-mode', 'overwrite']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: 'overwrite', cache_dir: '/kept/cache', temp_dir: '/kept/tmp' }));
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).toMatch(/Settings updated|Ustawienia zaktualizowane/);
    expect(all, 'only the push mode was set, so no directory may be listed as changed').not.toMatch(/cache-dir:|temp-dir:/);
    expect(all).not.toMatch(/Specify --cache-dir or --temp-dir together with --reset\.|Podaj --cache-dir lub --temp-dir razem z --reset\./);
  });

  // --- Several settings in one command ---------------------------------------

  // Every setting the operator typed is applied, in one write, and the output
  // lists what was set - so a flag that went unapplied is visible at once. A
  // value the command refuses (an unknown mode or feature, an unusable
  // directory, contradicting flags) refuses the whole command: half of the
  // typed changes on disk would leave the operator guessing which half.

  it('should apply --off and --push-mode together and list both', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ push_mode: 'overwrite', compression: { enabled: true, algorithm: 'deflate' } }) as never);

    const result = await runCmd(['config', '--off', 'compress', '--push-mode', 'new_version']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig, 'a push mode typed next to --off must not be dropped').toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ push_mode: 'new_version', compression: expect.objectContaining({ enabled: false }) }));
    const out = capture.logs.join('\n');
    expect(out).toMatch(/push-mode:\s+new_version/);
    expect(out).toMatch(/(compression|kompresja):\s+(disabled|wyłączone)/);
  });

  it('should apply --on together with directory and RAM settings and list each of them', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' } }) as never);

    const result = await runCmd(['config', '--on', 'compress', '--temp-dir', '/custom/tmp', '--max-ram', '512']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig, 'settings typed next to --on must not be dropped').toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ temp_dir: '/custom/tmp', max_ram_mb: 512, compression: expect.objectContaining({ enabled: true }) }),
    );
    const out = capture.logs.join('\n');
    expect(out).toMatch(/temp-dir:\s+\/custom\/tmp/);
    expect(out).toMatch(/max-ram:\s+512 MB/);
    expect(out).toMatch(/(compression|kompresja):\s+(enabled|włączone)/);
  });

  it('should apply --on and --off for two different features in one command', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' }, encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' } }) as never);

    const result = await runCmd(['config', '--on', 'compress', '--off', 'encryption']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig, '--off typed next to --on must not be dropped').toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ compression: expect.objectContaining({ enabled: true }), encryption: expect.objectContaining({ enabled: false }) }),
    );
    const out = capture.logs.join('\n');
    expect(out).toMatch(/(compression|kompresja):\s+(enabled|włączone)/);
    expect(out).toMatch(/(encryption|szyfrowanie):\s+(disabled|wyłączone)/);
  });

  it('should refuse the whole command when --push-mode next to --on is invalid', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' } }) as never);

    const code = await runCmdExitCode(['config', '--on', 'compress', '--push-mode', 'OVERWRITE']);

    expect(code).toBe(1);
    expect(mockWriteConfig, 'compression must not be switched on when the command is refused').not.toHaveBeenCalled();
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).toMatch(/Invalid --push-mode: "OVERWRITE"|Nieprawidłowy --push-mode: "OVERWRITE"/);
  });

  it('should refuse the whole command when a directory next to --off is unusable', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: true, algorithm: 'deflate' } }) as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => true } as never);
    mockStat.mockResolvedValueOnce({ isDirectory: () => false } as never);

    const result = await runCmd(['config', '--off', 'compress', '--temp-dir', '/parent/notadir']);

    expect(result).toBe('abort');
    expect(mockWriteConfig, 'compression must not be switched off when the command is refused').not.toHaveBeenCalled();
    expect([...capture.logs, ...capture.errors].join('\n')).toContain('bfs config --temp-dir');
  });

  it('should refuse an unknown --on feature with a non-zero exit, also next to another setting', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const code = await runCmdExitCode(['config', '--on', 'turbo', '--temp-dir', '/custom/tmp']);

    expect(code, 'a refusal that exits 0 cannot be told from an applied setting by a script').toBe(1);
    expect(mockWriteConfig, 'the directory must not be stored when the command is refused').not.toHaveBeenCalled();
  });

  it.each([['--on'], ['--off']])('should refuse an unknown feature given alone to %s with a non-zero exit', async (flag) => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const code = await runCmdExitCode(['config', flag, 'turbo']);

    expect(code, 'a refusal that exits 0 cannot be told from an applied setting by a script').toBe(1);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // Feature names are looked up in a plain object, so a name that only exists
  // on its prototype must not count as known - "constructor" or "__proto__"
  // resolving there would be applied as some feature or as none, with exit 0.
  it.each([
    ['--on', 'constructor'],
    ['--off', '__proto__'],
  ])('should refuse %s %s as an unknown feature', async (flag, name) => {
    mockReadConfig.mockResolvedValue(makeConfig({ encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' } }) as never);

    const code = await runCmdExitCode(['config', flag, name]);

    expect(code).toBe(1);
    expect(mockWriteConfig, 'a name that is not a feature must not change any setting').not.toHaveBeenCalled();
    expect([...capture.logs, ...capture.errors].join('\n')).toMatch(/Unknown feature|Nieznana funkcja/);
  });

  it('should refuse --on and --off naming the same feature, with a non-zero exit and no write', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' } }) as never);

    const code = await runCmdExitCode(['config', '--on', 'compress', '--off', 'compression']);

    expect(code, 'one of two contradicting flags must not win silently').toBe(1);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('should apply every feature when --on is given more than once', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' } }) as never);

    const result = await runCmd(['config', '--on', 'compress', '--on', 'encryption']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig, 'the first --on must not be dropped by the second').toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ compression: expect.objectContaining({ enabled: true }), encryption: expect.objectContaining({ enabled: true }) }),
    );
  });

  it('should apply every feature when --off is given more than once', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: true, algorithm: 'deflate' }, encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' } }) as never);

    const result = await runCmd(['config', '--off', 'compress', '--off', 'encryption']);

    expect(result).toBe('ok');
    expect(mockWriteConfig, 'the first --off must not be dropped by the second').toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ compression: expect.objectContaining({ enabled: false }), encryption: expect.objectContaining({ enabled: false }) }),
    );
  });

  // --reset acts on directory and RAM settings only; next to --on it has
  // nothing to act on and must not turn the command into the "--reset needs a
  // field" refusal, which would drop the feature switch.
  it('should switch the feature when --reset stands next to --on alone', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: false, algorithm: 'deflate' }, cache_dir: '/kept/cache' }) as never);

    const result = await runCmd(['config', '--reset', '--on', 'compress']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledTimes(1);
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ compression: expect.objectContaining({ enabled: true }), cache_dir: '/kept/cache' }));
    const all = [...capture.logs, ...capture.errors].join('\n');
    expect(all).not.toMatch(/Specify --cache-dir or --temp-dir together with --reset\.|Podaj --cache-dir lub --temp-dir razem z --reset\./);
  });

  // --- The output lists what was set, for a single setting too ---------------

  it.each([
    [['--temp-dir', '/custom/tmp'], /temp-dir:\s+\/custom\/tmp/],
    [['--cache-dir', '/custom/cache'], /cache-dir:\s+\/custom\/cache/],
    [['--max-ram', '256'], /max-ram:\s+256 MB/],
    [['--cache-dir', '--reset'], /cache-dir:\s+\((default|domyślnie)/],
    [['--max-ram', '--reset'], /max-ram:\s+\(auto/],
    [['--push-mode', 'ask'], /push-mode:\s+ask/],
    [['--on', 'encryption'], /(encryption|szyfrowanie):\s+(enabled|włączone)/],
  ])('should list the value set by %j', async (args, line) => {
    mockReadConfig.mockResolvedValue(makeConfig({ cache_dir: '/old/cache', max_ram_mb: 1024 }) as never);

    const result = await runCmd(['config', ...(args as string[])]);

    expect(result).toBe('ok');
    const out = capture.logs.join('\n');
    // The heading proves the list form: a one-line "<feature>: enabled."
    // notice would satisfy the value line alone.
    expect(out).toMatch(/Settings updated:|Ustawienia zaktualizowane:/);
    expect(out).toMatch(line as RegExp);
  });

  it('should still say that a compression or encryption change takes effect at the next push', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ compression: { enabled: true, algorithm: 'deflate' } }) as never);

    await runCmd(['config', '--off', 'compress', '--push-mode', 'ask']);

    expect(capture.logs.join('\n')).toMatch(/next push|następnym push/);
  });
});
