import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({
  listVersions: vi.fn(),
}));

import { listVersions } from '../../src/vault/vault-manager.js';

const mockListVersions = vi.mocked(listVersions);

function makeManifest(version: number, overrides: object = {}) {
  return {
    version,
    health: 'healthy' as const,
    shards: [],
    scheme: { data_shards: 2, parity_shards: 1 },
    file_count: 10,
    total_size: 1024,
    pushed_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('versions', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
  });

  // ─── Brak wersji ──────────────────────────────────────────────────────────

  it('should show "no versions" message when list is empty', async () => {
    mockListVersions.mockResolvedValue([]);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('No versions');
    expect(output).toContain('push');
  });

  // ─── Tabela wersji ────────────────────────────────────────────────────────

  it('should display version numbers in output', async () => {
    mockListVersions.mockResolvedValue([
      makeManifest(1),
      makeManifest(5),
    ] as never);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('001');
    expect(output).toContain('005');
  });

  it('should display health status in table header', async () => {
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('Status');
  });

  it('should display scheme N/K in output', async () => {
    mockListVersions.mockResolvedValue([
      makeManifest(1, { scheme: { data_shards: 3, parity_shards: 2 } }),
    ] as never);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('3/2');
  });

  it('should display "?" for file_count when null (pipeline: manifest from recovery)', async () => {
    // Per pipeline: po recovery pushed_at=null, file_count=null, total_size=null
    // uzupełniane automatycznie po pierwszym pull
    mockListVersions.mockResolvedValue([
      makeManifest(1, { file_count: null, total_size: null }),
    ] as never);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('?');
  });

  it('should display "—" for pushed_at when null (manifest from recovery)', async () => {
    mockListVersions.mockResolvedValue([
      makeManifest(1, { pushed_at: null }),
    ] as never);

    await runCmd(['versions']);

    expect(capture.logs.some((l) => l.includes('—'))).toBe(true);
  });

  it('should include all column headers in table', async () => {
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmd(['versions']);

    const output = capture.logs.join('\n');
    expect(output).toContain('Version');
    expect(output).toContain('Scheme');
    expect(output).toContain('Shards');
    expect(output).toContain('Files');
    expect(output).toContain('Size');
  });

  // ─── Błąd ─────────────────────────────────────────────────────────────────

  it('should abort when listVersions throws', async () => {
    mockListVersions.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['versions']);

    expect(result).toBe('abort');
    expect(
      capture.errors.some((e) => e.includes('No vault config found')),
    ).toBe(true);
  });
});
