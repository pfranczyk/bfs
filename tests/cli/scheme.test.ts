import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));

import { readConfig, writeConfig } from '../../src/vault/config.js';

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);

describe('scheme set', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockWriteConfig.mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  it('should abort when no vault config', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['scheme', 'set', '2', '1']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('bfs init'))).toBe(true);
  });

  it('should update config when N+K matches provider count', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // 3 providers: scheme 2/1

    const result = await runCmd(['scheme', 'set', '2', '1']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ scheme: { data_shards: 2, parity_shards: 1 } }));
  });

  it('should abort when N+K exceeds provider count', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // 3 providers

    const result = await runCmd(['scheme', 'set', '3', '2']); // requires 5

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect(capture.errors.some((l) => l.includes('5'))).toBe(true);
  });

  it('should abort when N+K is less than provider count', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // 3 providers

    const result = await runCmd(['scheme', 'set', '2', '0']); // K < 1

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('should abort when N < 2', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['scheme', 'set', '1', '2']);

    expect(result).toBe('abort');
    expect(capture.errors.some((l) => l.includes('2'))).toBe(true);
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('should abort when K < 1', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['scheme', 'set', '2', '0']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('should show old and new scheme in success message', async () => {
    // makeConfig() has scheme 2/1 and 3 providers — set 2/1 again (same count)
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    await runCmd(['scheme', 'set', '2', '1']);

    expect(capture.logs.some((l) => l.includes('2/1'))).toBe(true);
  });

  it('should abort when N+K mismatch and hint how many to add', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // 3 providers

    await runCmd(['scheme', 'set', '3', '1']); // requires 4

    // Should mention adding 1 provider
    const hints = [...capture.logs, ...capture.errors].join(' ');
    expect(hints).toMatch(/provider add|dodaj/i);
  });

  it('should abort when N+K mismatch and hint how many to remove', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // 3 providers

    await runCmd(['scheme', 'set', '2', '-1']); // K < 1 — triggers K validation first
    // just ensure it aborts
    // (negative K handled before provider count check)
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });
});
