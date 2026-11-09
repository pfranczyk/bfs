import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

vi.mock('../../src/vault/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/config.js')>();
  return { ...actual, readConfig: vi.fn(), writeConfig: vi.fn() };
});
vi.mock('../../src/vault/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/manifest.js')>();
  return { ...actual, listManifests: vi.fn() };
});
vi.mock('../../src/vault/repair.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/repair.js')>();
  return { ...actual, repairVault: vi.fn() };
});

import { readConfig } from '../../src/vault/config.js';
import { listManifests } from '../../src/vault/manifest.js';
import { repairVault } from '../../src/vault/repair.js';

const mockReadConfig = vi.mocked(readConfig);
const mockListManifests = vi.mocked(listManifests);
const mockRepairVault = vi.mocked(repairVault);

// `bfs repair --rebuild <free-entry> "<type>:<recorded-name> <settings>"` puts
// the recorded name into the configuration before it rebuilds anything, and
// keeps it once a version has been committed under it. A run that fails after
// that leaves the pool one entry over its scheme, so every backup command is
// refused, and the failure itself advises the way to finish - the same command
// again. That retry finds the recorded name already configured, exactly
// as the first run wrote it, and has to carry on instead of calling it a
// collision.
//
// The collision check stays where it means something: a name already configured
// with DIFFERENT settings is another storage, and migrating onto it would merge
// two storages under one name.

const SPARE = path.join(os.tmpdir(), 'bfs-repair-resume-spare');
const OTHER = path.join(os.tmpdir(), 'bfs-repair-resume-other');

/** The pool a failed first run leaves: survivors, the free entry p4 and the recorded name p3. */
function halfFinishedConfig(p3Path: string) {
  return makeConfig({
    scheme: { data_shards: 3, parity_shards: 1 },
    providers: [
      { id: 'p0', type: 'local', adapterPackage: null, config: { path: '/tmp/d0' } },
      { id: 'p1', type: 'local', adapterPackage: null, config: { path: '/tmp/d1' } },
      { id: 'p2', type: 'local', adapterPackage: null, config: { path: '/tmp/d2' } },
      { id: 'p4', type: 'local', adapterPackage: null, config: { path: SPARE } },
      { id: 'p3', type: 'local', adapterPackage: null, config: { path: p3Path } },
    ],
  });
}

describe('repair --rebuild retried after a partial failure', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockListManifests.mockResolvedValue([
      { version: 1, shards: [] },
      { version: 2, shards: [] },
    ] as never);
    mockRepairVault.mockResolvedValue({ succeeded: [{ old_name: 'p4', new_name: 'p3' }], failed_pairs: [], failed_shards: [] } as never);
  });

  afterEach(() => {
    capture.restore();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should accept the recorded name the first run already configured with the same settings', async () => {
    mockReadConfig.mockResolvedValue(halfFinishedConfig(SPARE) as never);

    const result = await runCmd(['repair', '--version', 'all', '--rebuild', 'p4', `local:p3 --path ${SPARE}`]);

    expect(capture.errors.join('\n')).not.toContain('already exists');
    expect(result).toBe('ok');
    expect(mockRepairVault).toHaveBeenCalledOnce();
    // The retry carries the same migration pair the first run did.
    const [, options] = mockRepairVault.mock.calls[0];
    expect(options.pairs).toHaveLength(1);
    expect(options.pairs[0]).toMatchObject({ oldName: 'p4', isMigration: true, newConfig: { id: 'p3', type: 'local', config: { path: SPARE } } });
  });

  // The classic replacement `old -> new` retried: the versions already rebuilt
  // record the new storage, the rest still record the old one - but no version
  // records both, so the retry is accepted.
  it('should accept the retry of a classic replacement whose versions record either name but never both', async () => {
    mockReadConfig.mockResolvedValue(
      makeConfig({
        scheme: { data_shards: 2, parity_shards: 1 },
        providers: [
          { id: 'p0', type: 'local', adapterPackage: null, config: { path: '/tmp/d0' } },
          { id: 'p1', type: 'local', adapterPackage: null, config: { path: '/tmp/d1' } },
          { id: 'p2', type: 'local', adapterPackage: null, config: { path: '/tmp/d2' } },
          { id: 'p3', type: 'local', adapterPackage: null, config: { path: SPARE } },
        ],
      }) as never,
    );
    mockListManifests.mockResolvedValue([
      { version: 1, shards: [{ provider_id: 'p0' }, { provider_id: 'p1' }, { provider_id: 'p2' }] },
      { version: 2, shards: [{ provider_id: 'p0' }, { provider_id: 'p1' }, { provider_id: 'p3' }] },
    ] as never);

    const result = await runCmd(['repair', '--version', 'all', '--rebuild', 'p2', `local:p3 --path ${SPARE}`]);

    expect(capture.errors.join('\n')).not.toContain('already exists');
    expect(result).toBe('ok');
    expect(mockRepairVault).toHaveBeenCalledOnce();
  });

  // Control: only a rebuild leaves the pool over its scheme, so only a rebuild
  // retry may name a configured destination. The same pair without
  // `--rebuild` stays a collision.
  it('should refuse the recorded name without --rebuild even on a pool over its scheme', async () => {
    mockReadConfig.mockResolvedValue(halfFinishedConfig(SPARE) as never);

    const result = await runCmd(['repair', '--version', 'all', 'p4', `local:p3 --path ${SPARE}`]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('Provider "p3" already exists');
    expect(mockRepairVault).not.toHaveBeenCalled();
  });

  // Control: on an over-full pool a configured name with identical settings is
  // still not a retry when a version already records it next to the pair's
  // source. Migrating the source onto it would leave that version with two
  // parts under one storage name. A real retry never has that shape: the
  // rebuild moves each version from the source to the destination, so no
  // version names both.
  it('should refuse a target that a version already records next to the source', async () => {
    mockReadConfig.mockResolvedValue(halfFinishedConfig(SPARE) as never);
    mockListManifests.mockResolvedValue([{ version: 1, shards: [{ provider_id: 'p4' }, { provider_id: 'p3' }, { provider_id: 'p0' }] }] as never);

    const result = await runCmd(['repair', '--version', 'all', '--rebuild', 'p4', `local:p3 --path ${SPARE}`]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('Provider "p3" already exists');
    expect(mockRepairVault).not.toHaveBeenCalled();
  });

  // Control: identical settings alone do not make a retry. On a pool that
  // matches its scheme the name is a full member of the pool, and migrating a
  // free entry onto it would leave two entries for one storage.
  it('should refuse the recorded name with the same settings when the pool matches the scheme', async () => {
    const cfg = halfFinishedConfig(SPARE);
    mockReadConfig.mockResolvedValue({ ...cfg, scheme: { data_shards: 3, parity_shards: 2 } } as never);

    const result = await runCmd(['repair', '--version', 'all', '--rebuild', 'p4', `local:p3 --path ${SPARE}`]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('Provider "p3" already exists');
    expect(mockRepairVault).not.toHaveBeenCalled();
  });

  // Control: the same name configured with other settings is a different
  // storage, so the retry exemption must not open a way to merge two of them.
  it('should still refuse a recorded name configured with different settings', async () => {
    mockReadConfig.mockResolvedValue(halfFinishedConfig(OTHER) as never);

    const result = await runCmd(['repair', '--version', 'all', '--rebuild', 'p4', `local:p3 --path ${SPARE}`]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('Provider "p3" already exists');
    expect(mockRepairVault).not.toHaveBeenCalled();
  });
});
