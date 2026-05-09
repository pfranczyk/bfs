import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
}));

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
    mockReadConfig.mockResolvedValue(
      makeConfig({
        providers: [
          { id: 'local-1', type: 'local', config: { path: '/mnt/usb' } },
        ],
      }) as never,
    );

    await runCmd(['provider', 'list']);

    const output = capture.logs.join('\n');
    expect(output).toContain('/mnt/usb');
  });
});
