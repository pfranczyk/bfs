import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn() }));
vi.mock('../../src/vault/verify.js', () => ({ verifyAll: vi.fn() }));
vi.mock('ora', () => ({ default: (text: string) => ({ text, start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis() }) }));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  return { ...actual, createCliProviderIO: vi.fn(() => ({ ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn(), choose: vi.fn(), info: vi.fn(), warn: vi.fn(), progress: vi.fn() })) };
});

import { listVersions } from '../../src/vault/vault-manager.js';
import { verifyAll } from '../../src/vault/verify.js';

const mockListVersions = vi.mocked(listVersions);
const mockVerifyAll = vi.mocked(verifyAll);

/** VerifyReport fixture matching VerifyReport type from vault/verify.ts. */
function makeReport(versions: Array<{ version: number; health: VersionHealth; available_shards: number; total_shards: number; tolerance: number }>) {
  return { versions: versions.map((v) => ({ ...v, header_advisory: null })) };
}

function makeManifest(version: number, dataN = 2, parityK = 1) {
  return { version, health: VersionHealth.Healthy, shards: [], scheme: { data_shards: dataN, parity_shards: parityK }, file_count: null, total_size: null, pushed_at: null };
}

describe('verify', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Brak wersji ──────────────────────────────────────────────────────────

  it('should show "no versions" message when report is empty', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([]));
    mockListVersions.mockResolvedValue([]);

    await runCmd(['verify']);

    expect(capture.logs.some((l) => l.includes('No versions'))).toBe(true);
  });

  // ─── Tabela wyników ───────────────────────────────────────────────────────

  it('should display column headers', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('Version');
    expect(output).toContain('Status');
    expect(output).toContain('Available');
    expect(output).toContain('Tolerance');
  });

  it('should display version number in output', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 7, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(7)] as never);

    await runCmd(['verify']);

    expect(capture.logs.some((l) => l.includes('007'))).toBe(true);
  });

  // ─── Zdrowie i tolerancja (pipeline krok 2) ───────────────────────────────

  it('healthy version (N+K shards): tolerance = K', async () => {
    // Scheme 2/1 (N=2, K=1), all 3 shards available → healthy, tolerance = 3-2 = 1
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 2, 1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('1'); // tolerance
  });

  it('degraded version (>=N but <N+K shards): tolerance = available - N', async () => {
    // Scheme 2/1 (N=2, K=1), 2/3 shards → degraded, tolerance = 2-2 = 0
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 2, 1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('2/3');
    expect(output).toContain('0'); // tolerance = 0 (degraded to limit)
  });

  it('damaged version (<N shards): tolerance = 0', async () => {
    // Scheme 2/1 (N=2, K=1), only 1 shard → damaged
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Damaged, available_shards: 1, total_shards: 3, tolerance: 0 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 2, 1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('1/3');
    expect(output).toContain('0'); // tolerance = 0 (available < N)
  });

  it('should display scheme N/K per version', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 7, total_shards: 7, tolerance: 2 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 5, 2)] as never);

    await runCmd(['verify']);

    expect(capture.logs.some((l) => l.includes('5/2'))).toBe(true);
  });

  it('should show "?" for scheme when manifest not found', async () => {
    // verifyAll reports version 99, but listVersions returns nothing for it
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 99, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([] as never);

    await runCmd(['verify']);

    expect(capture.logs.some((l) => l.includes('?'))).toBe(true);
  });

  // ─── Błąd verify ──────────────────────────────────────────────────────────

  it('should abort when verifyAll throws', async () => {
    mockVerifyAll.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['verify']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('No vault config found'))).toBe(true);
  });
});
