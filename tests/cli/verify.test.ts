import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHealth } from '../../src/types/index.js';
import type { VersionLoss } from '../../src/vault/verify.js';
import { captureConsole, runCmd, runCmdExitCode } from './_helpers.js';

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

/**
 * VerifyReport fixture shaped like VerifyReport from vault/verify.ts.
 *
 * `pool` describes the pool behind a storage the versions record but the
 * configuration does not list. It is not part of the report type: the counts are
 * handed in on purpose, so a remedy that came back keyed to them would have them
 * to read - and the tests reading the output would see it.
 */
function makeReport(
  versions: Array<{ version: number; health: VersionHealth; available_shards: number; total_shards: number; tolerance: number }>,
  pool: Nullable<{ configured: number; required: number; missing: number; unused: number }> = null,
) {
  return { versions: versions.map((v) => ({ ...v, header_advisory: null, retained_from_deep: false, loss_causes: [] as VersionLoss[] })), unknown_provider: pool };
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

  // --- No versions ----------------------------------------------------------

  it('should show "no versions" message when report is empty', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([]));
    mockListVersions.mockResolvedValue([]);

    await runCmd(['verify']);

    expect(capture.logs.some((l) => l.includes('No versions'))).toBe(true);
  });

  // --- Results table --------------------------------------------------------

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

  // --- Health and tolerance (pipeline step 2) -------------------------------

  it('healthy version (N+K shards): tolerance = K', async () => {
    // Scheme 2/1 (N=2, K=1), all 3 shards available -> healthy, tolerance = 3-2 = 1
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 2, 1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('1'); // tolerance
  });

  it('degraded version (>=N but <N+K shards): tolerance = available - N', async () => {
    // Scheme 2/1 (N=2, K=1), 2/3 shards -> degraded, tolerance = 2-2 = 0
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 }]));
    mockListVersions.mockResolvedValue([makeManifest(1, 2, 1)] as never);

    await runCmd(['verify']);

    const output = capture.logs.join('\n');
    expect(output).toContain('2/3');
    expect(output).toContain('0'); // tolerance = 0 (degraded to limit)
  });

  it('damaged version (<N shards): tolerance = 0', async () => {
    // Scheme 2/1 (N=2, K=1), only 1 shard -> damaged
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

  // --- verify errors --------------------------------------------------------

  it('should abort when verifyAll throws', async () => {
    mockVerifyAll.mockRejectedValue(new Error('No vault config found'));

    const result = await runCmd(['verify']);

    expect(result).toBe('abort');
    expect(capture.errors.some((e) => e.includes('No vault config found'))).toBe(true);
  });

  // --- exit codes -----------------------------------------------------------
  // The code is the only signal a scheduled check can act on, and it must stay
  // distinct from the generic failure code so a monitor can tell "the backup is
  // damaged" from "the check could not run".

  it('should exit 0 when every version is healthy', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    expect(await runCmdExitCode(['verify'])).toBe(0);
  });

  it('should exit 4 when a version is degraded', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 }]));
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    expect(await runCmdExitCode(['verify'])).toBe(4);
  });

  it('should exit 5 when any version is damaged, even beside healthy ones', async () => {
    mockVerifyAll.mockResolvedValue(
      makeReport([
        { version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 },
        { version: 2, health: VersionHealth.Damaged, available_shards: 1, total_shards: 3, tolerance: 0 },
      ]),
    );
    mockListVersions.mockResolvedValue([makeManifest(1), makeManifest(2)] as never);

    expect(await runCmdExitCode(['verify'])).toBe(5);
  });

  it('should exit 1 - not a health code - when verify itself cannot run', async () => {
    mockVerifyAll.mockRejectedValue(new Error('No vault config found'));

    expect(await runCmdExitCode(['verify'])).toBe(1);
  });

  // --- loss causes ----------------------------------------------------------
  // The Available column says how many parts are left; it cannot say why the
  // rest are gone, and the moves differ per cause. Each cause therefore gets one
  // line naming the version it belongs to and every medium behind it - one line
  // per cause, not one per part, so a wide pool does not bury the table.

  it('should name the media behind each cause, one line per cause', async () => {
    const report = makeReport([{ version: 1, health: VersionHealth.Damaged, available_shards: 1, total_shards: 4, tolerance: 0 }]);
    const first = report.versions[0];
    if (first === undefined) throw new Error('fixture must contain one version');
    first.loss_causes = [
      { cause: 'medium_unreachable', providers: ['usb-1'] },
      { cause: 'file_missing', providers: ['nas-1', 'nas-2'] },
    ];
    mockVerifyAll.mockResolvedValue(report);
    mockListVersions.mockResolvedValue([makeManifest(1, 3, 1)] as never);

    await runCmdExitCode(['verify']);

    const warned = capture.errors.join('\n');
    // The sentence per cause is the one a failed restore already uses for the
    // same state, so the two commands cannot drift apart; verify adds only the
    // version, which a restore does not need to name.
    expect(warned).toContain('Version v001 - Storage not reachable: usb-1.');
    expect(warned).toContain('Version v001 - Backup data missing on: nas-1, nas-2.');
  });

  it('should tell a failed transfer from damaged data in the line it prints', async () => {
    const report = makeReport([{ version: 2, health: VersionHealth.Degraded, available_shards: 2, total_shards: 4, tolerance: 0 }]);
    const first = report.versions[0];
    if (first === undefined) throw new Error('fixture must contain one version');
    first.loss_causes = [
      { cause: 'read_failed', providers: ['ftp-1'] },
      { cause: 'data_corrupt', providers: ['usb-1'] },
    ];
    mockVerifyAll.mockResolvedValue(report);
    mockListVersions.mockResolvedValue([makeManifest(2, 3, 1)] as never);

    await runCmdExitCode(['verify']);

    const warned = capture.errors.join('\n');
    expect(warned).toContain('Version v002 - Damaged backup data on: usb-1.');
    // The medium that timed out must not be described as holding damaged data:
    // nothing arrived from it, so its bytes were never judged. Asserted on the
    // whole sentence, not on the medium's name - a name alone is satisfied by
    // any wording, including the one this check exists to rule out.
    expect(warned).toContain('Version v002 - Backup data that could not be read - the transfer did not finish, on: ftp-1.');
    expect(warned).not.toContain('Damaged backup data on: ftp-1');
  });

  // A header that disagrees with the manifest is a finding whatever caused it,
  // but the line must not say whose part it is. Five of the six compared fields
  // address the part; `blob_hash` describes its content and has a legal window
  // of disagreement - an interrupted `push --overwrite` leaves this version's
  // own newer part beside a manifest describing the older content. Calling that
  // a part of another version would be untrue.
  it('should report a disagreeing header without claiming the part belongs elsewhere', async () => {
    const report = makeReport([{ version: 1, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 }]);
    const first = report.versions[0];
    if (first === undefined) throw new Error('fixture must contain one version');
    first.loss_causes = [{ cause: 'header_mismatch', providers: ['p0'] }];
    mockVerifyAll.mockResolvedValue(report);
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmdExitCode(['verify']);

    const warned = capture.errors.join('\n');
    expect(warned).toContain("Version v001 - Backup data that does not match this version's record, on: p0.");
    expect(warned).not.toContain('belong');
  });

  // Every version is reported, not just the first one that lost something - the
  // version is the whole reason these lines carry a number, and a check run over
  // a long history is exactly where a loop that stops early goes unnoticed.
  it('should name the causes of every version, not only the first', async () => {
    const report = makeReport([
      { version: 1, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 },
      { version: 2, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 },
    ]);
    const [first, second] = report.versions;
    if (first === undefined || second === undefined) throw new Error('fixture must contain two versions');
    first.loss_causes = [{ cause: 'file_missing', providers: ['usb-1'] }];
    second.loss_causes = [{ cause: 'medium_unreachable', providers: ['ftp-1'] }];
    mockVerifyAll.mockResolvedValue(report);
    mockListVersions.mockResolvedValue([makeManifest(1), makeManifest(2)] as never);

    await runCmdExitCode(['verify']);

    const warned = capture.errors.join('\n');
    expect(warned).toContain('Version v001 - Backup data missing on: usb-1.');
    expect(warned).toContain('Version v002 - Storage not reachable: ftp-1.');
  });

  it('should print no cause line for a healthy backup', async () => {
    mockVerifyAll.mockResolvedValue(makeReport([{ version: 1, health: VersionHealth.Healthy, available_shards: 3, total_shards: 3, tolerance: 1 }]));
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmdExitCode(['verify']);

    const warned = capture.errors.join('\n');
    expect(warned).not.toContain('Version v001 - ');
  });

  // --- a storage outside the configuration: the state, and only the state -----
  // The cause line names the storage the backup records and the configuration
  // no longer lists. Saying what is the case is what verify is for; what to do
  // about it depends on why the storage left - removed for good, replaced,
  // renamed by an interrupted repair - which verify cannot tell. So no command
  // is offered: not the repair that would bring the name back, not the scheme
  // change, not a fresh copy. Each state the pool can be in is checked on its
  // own: the pool is counted differently in each, so a remedy keyed to those
  // counts would surface in one state and not the others.

  /** Report carrying versions that lost a part to a name the config lost. */
  function reportWithUnknownProvider(pool: { configured: number; required: number; missing: number; unused: number }, versions = [5]) {
    const report = makeReport(
      versions.map((version) => ({ version, health: VersionHealth.Degraded, available_shards: 2, total_shards: 3, tolerance: 0 })),
      pool,
    );
    for (const v of report.versions) v.loss_causes = [{ cause: 'provider_not_configured', providers: ['usb-2'] }];
    return report;
  }

  const POOL_STATES = [
    { label: 'a configured storage is used by no version', pool: { configured: 3, required: 3, missing: 1, unused: 1 } },
    { label: 'fewer storages are configured than the scheme requires', pool: { configured: 3, required: 4, missing: 1, unused: 0 } },
    { label: 'every configured storage is already taken', pool: { configured: 3, required: 3, missing: 1, unused: 0 } },
  ];
  const COMMANDS = ['bfs repair', 'bfs scheme set', 'bfs push', 'bfs pull', 'bfs prune', 'bfs provider add'];

  for (const { label, pool } of POOL_STATES) {
    it(`should name the storage and offer no command when ${label}`, async () => {
      mockVerifyAll.mockResolvedValue(reportWithUnknownProvider(pool));
      mockListVersions.mockResolvedValue([makeManifest(5)] as never);

      await runCmdExitCode(['verify']);

      const out = [...capture.logs, ...capture.errors].join('\n');
      for (const command of COMMANDS) expect(out, `verify must not offer \`${command}\``).not.toContain(command);
      // The warning channel carries the cause line and nothing after it - so a
      // remedy reworded to name no command at all is caught as well.
      const warnings = capture.errors.filter((line) => line.trim() !== '');
      expect(warnings).toEqual([expect.stringContaining('Version v005 - Storage recorded in this backup but absent from the configuration: usb-2.')]);
    });
  }

  it('should name the storage under every version that lost it', async () => {
    mockVerifyAll.mockResolvedValue(reportWithUnknownProvider({ configured: 3, required: 3, missing: 1, unused: 1 }, [5, 6, 7]));
    mockListVersions.mockResolvedValue([makeManifest(5), makeManifest(6), makeManifest(7)] as never);

    await runCmdExitCode(['verify']);

    // Every version gets its own state line - the version number is the whole
    // reason those lines carry one.
    const out = [...capture.logs, ...capture.errors].join('\n');
    expect(out).toContain('Version v005 - Storage recorded');
    expect(out).toContain('Version v006 - Storage recorded');
    expect(out).toContain('Version v007 - Storage recorded');
  });

  it('should explain a verdict it carried over from a deep check', async () => {
    const report = makeReport([{ version: 1, health: VersionHealth.Damaged, available_shards: 3, total_shards: 3, tolerance: 1 }]);
    const first = report.versions[0];
    if (first === undefined) throw new Error('fixture must contain one version');
    first.retained_from_deep = true;
    mockVerifyAll.mockResolvedValue(report);
    mockListVersions.mockResolvedValue([makeManifest(1)] as never);

    await runCmdExitCode(['verify']);

    expect(capture.errors.some((w) => w.includes('earlier deep check'))).toBe(true);
  });
});
