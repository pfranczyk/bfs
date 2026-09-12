import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/config.js')>();
  return { ...actual, readConfig: vi.fn(), writeConfig: vi.fn() };
});

import { readConfig } from '../../src/vault/config.js';

const mockReadConfig = vi.mocked(readConfig);

describe('provider list', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  it('should show error when no vault config exists', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['provider', 'list']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('bfs init'))).toBe(true);
  });

  it('should show message when no providers configured', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ providers: [] }) as never);

    await runCmd(['provider', 'list']);

    expect(capture.logs.some((l) => l.includes('No providers'))).toBe(true);
  });

  it('should display table with #/Name/Type/Configuration columns', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('#');
    expect(output).toContain('Name');
    expect(output).toContain('Type');
    expect(output).toContain('Configuration');
  });

  it('should show provider IDs in table', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('dysk-1');
    expect(output).toContain('dysk-2');
    expect(output).toContain('dysk-3');
  });

  it('should show vault name and scheme in header', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('test-vault');
    expect(output).toContain('2/1');
  });

  it('should show indices 0, 1, 2 in # column', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('0');
    expect(output).toContain('1');
    expect(output).toContain('2');
  });

  it('should show connection config for local provider', async () => {
    mockReadConfig.mockResolvedValue(makeConfig({ providers: [{ id: 'local-1', type: 'local', config: { path: '/mnt/usb' } }] }) as never);

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('/mnt/usb');
  });
});

// This suite's config.js mock only overrides readConfig/writeConfig, so
// `init` (also registered by buildTestProgram()) reaches the real
// assertNoExistingVault - the mock spreads `...actual` and does not stub it.
describe('init reaches the real assertNoExistingVault through an unrelated mock', () => {
  let capture: ReturnType<typeof captureConsole>;
  let tmpDir: string;

  beforeEach(async () => {
    capture = captureConsole();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-provider-list-init-'));
  });

  afterEach(async () => {
    capture.restore();
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should abort on missing --ci vault name, not on a missing mock export', async () => {
    const result = await runCmd(['--cwd', tmpDir, 'init', '--ci']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('--ci mode requires backup name'))).toBe(true);
    // Negative check tied to Vitest's actual wording (not a substring nobody emits):
    // a mock missing this export throws '... export is defined on the "..." mock.
    // Did you forget to return it from "vi.mock"?' - assertNoExistingVault would
    // surface that message instead of the real CLI validation above.
    expect(capture.errors.some((l) => l.includes('Did you forget to return it from'))).toBe(false);
  });
});
