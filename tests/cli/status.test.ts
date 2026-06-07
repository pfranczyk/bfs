import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ status: vi.fn() }));

import { status } from '../../src/vault/vault-manager.js';

const mockStatus = vi.mocked(status);

/** Minimal StatusInfo fixture. */
function makeStatusInfo(overrides: object = {}) {
  return { vault_name: 'test-vault', latest_version: 3, working_version: 3, scheme: { data_shards: 2, parity_shards: 1 }, encryption_enabled: false, provider_count: 3, ...overrides };
}

describe('status', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Dane wyświetlane ──────────────────────────────────────────────────────

  it('should display vault name', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo() as never);

    await runCmd(['status']);

    expect(capture.logs.some((l) => l.includes('test-vault'))).toBe(true);
  });

  it('should display latest_version and working_version', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ latest_version: 7, working_version: 5 }) as never);

    await runCmd(['status']);

    const output = capture.logs.join('\n');
    expect(output).toContain('v7');
    expect(output).toContain('v5');
  });

  it('should display scheme N/K', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ scheme: { data_shards: 3, parity_shards: 2 } }) as never);

    await runCmd(['status']);

    const output = capture.logs.join('\n');
    expect(output).toContain('3');
    expect(output).toContain('2');
  });

  it('should display encryption as disabled when encryption_enabled=false', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ encryption_enabled: false }) as never);

    await runCmd(['status']);

    expect(capture.logs.some((l) => l.includes('disabled'))).toBe(true);
  });

  it('should display encryption as enabled when encryption_enabled=true', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ encryption_enabled: true }) as never);

    await runCmd(['status']);

    expect(capture.logs.some((l) => l.includes('enabled'))).toBe(true);
  });

  it('should display provider count', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ provider_count: 5 }) as never);

    await runCmd(['status']);

    expect(capture.logs.some((l) => l.includes('5'))).toBe(true);
  });

  // ─── Push-disabled scheme warn ────────────────────────────────────────────

  it('should NOT print push-disabled warn when scheme is 2/1', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ scheme: { data_shards: 2, parity_shards: 1 } }) as never);

    await runCmd(['status']);

    const all = capture.logs.concat(capture.errors).join('\n');
    expect(all).not.toMatch(/push disabled|push wyłączony/i);
  });

  it('should print push-disabled warn when scheme is 3/0', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ scheme: { data_shards: 3, parity_shards: 0 } }) as never);

    await runCmd(['status']);

    const all = capture.logs.concat(capture.errors).join('\n');
    expect(all).toMatch(/push disabled|push wyłączony/i);
    expect(all).toMatch(/3\/0/);
  });

  it('should print push-disabled warn when scheme is 1/0', async () => {
    mockStatus.mockResolvedValue(makeStatusInfo({ scheme: { data_shards: 1, parity_shards: 0 } }) as never);

    await runCmd(['status']);

    const all = capture.logs.concat(capture.errors).join('\n');
    expect(all).toMatch(/push disabled|push wyłączony/i);
    expect(all).toMatch(/1\/0/);
  });

  // ─── Błąd status ──────────────────────────────────────────────────────────

  it('should abort when vault config is missing', async () => {
    mockStatus.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['status']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('No vault config found'))).toBe(true);
  });

  it('should abort on any unexpected error', async () => {
    mockStatus.mockRejectedValue(new Error('disk I/O error'));

    const result = await runCmd(['status']);

    expect(result).toBe('abort');
  });
});
