import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, ProviderError, TamperDetectedError } from '../../src/core/errors.js';
import { computeShardHeaderSize } from '../../src/core/shard-io.js';
import { t } from '../../src/i18n/index.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, VaultState } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { readManifest } from '../../src/vault/manifest.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, push, removeProvider } from '../../src/vault/vault-manager.js';

// `provider remove --strategy rebuild` is the operator saying "this storage is
// gone, move its parts elsewhere". A target that cannot take the parts must
// leave the backup exactly as it was - old storage still configured, nothing
// pretending to have moved - and say so as a failure. Rebuilding is done
// version by version, so the rules are about the loop: probe the target once
// before fetching anything, verify every part after writing it, stop at the
// first failure that will repeat for every version (the target refusing, a
// sibling not answering), carry on past a sibling that merely lacks a part,
// and touch the configuration only once every version in scope is rebuilt and
// confirmed.

const VAULT = 'rebuild-target';
const TARGET = 'p3';
const REMOVED = 'p0';
const TARGET_UNUSABLE = 'is not usable';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** Which LocalFsProvider a prototype-level spy was invoked on. */
function idOf(self: unknown): string {
  return (self as { id?: string }).id ?? '';
}

async function providerIds(root: string): Promise<string[]> {
  const config = await readConfig(root);
  assert(config !== null, 'config must exist');
  return config.providers.map((p) => p.id);
}

async function health(root: string, version: number): Promise<VersionHealth> {
  const manifest = await readManifest(root, version);
  assert(manifest !== null, `manifest v${version} must exist`);
  return manifest.health;
}

async function shardOwner(root: string, version: number, shardIndex: number): Promise<string | undefined> {
  const manifest = await readManifest(root, version);
  assert(manifest !== null, `manifest v${version} must exist`);
  return manifest.shards.find((s) => s.shard_index === shardIndex)?.provider_id;
}

/** Flips one payload bit, leaving the trailing checksum stale - bit-rot on the medium. */
async function rotShardPayload(file: string): Promise<void> {
  const data = await fs.readFile(file);
  const pos = computeShardHeaderSize(data);
  data.writeUInt8(data.readUInt8(pos) ^ 0x01, pos);
  await fs.writeFile(file, data);
}

/** Runs the rebuild and returns the error it rejects with. */
async function rebuildFailure(root: string, io: ProviderIO): Promise<Error> {
  try {
    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io });
  } catch (err: unknown) {
    assert(err instanceof Error, 'removeProvider must reject with an Error');
    return err;
  }
  throw new Error('removeProvider was expected to reject');
}

/** A vault of the given scheme with the target already registered as a spare. */
async function setupVault(scheme: { data_shards: number; parity_shards: number }, io: ProviderIO, versions: number, targetId = TARGET): Promise<{ root: string; pdirs: string[]; targetDir: string }> {
  const count = scheme.data_shards + scheme.parity_shards;
  const root = await mkTmp('bfs-rebuildtest-root-');
  const pdirs: string[] = [];
  for (let i = 0; i < count; i++) pdirs.push(await mkTmp(`bfs-rebuildtest-p${i}-`));
  const targetDir = await mkTmp('bfs-rebuildtest-target-');
  await init(root, {
    vault_name: VAULT,
    scheme,
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io,
  });
  for (let v = 1; v <= versions; v++) {
    await fs.writeFile(path.join(root, 'a.txt'), `version ${v} `.repeat(2000), 'utf-8');
    await push(root, { io });
  }
  // The CLI persists a brand-new target before calling removeProvider; the
  // config carries it from here on and it is the CLI's job to withdraw it.
  const config = await readConfig(root);
  assert(config !== null);
  await writeConfig(root, { ...config, providers: [...config.providers, localProvider(targetId, targetDir)] });
  return { root, pdirs, targetDir };
}

describe('provider remove --strategy rebuild onto a target that cannot take the parts', () => {
  let root: string;
  let pdirs: string[];
  let targetDir: string;
  let io: ProviderIO;
  let stateBefore: VaultState;

  beforeEach(async () => {
    io = createMockProviderIO({}, '', false).io;
    ({ root, pdirs, targetDir } = await setupVault({ data_shards: 2, parity_shards: 1 }, io, 2));
    stateBefore = await readState(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs, targetDir]) await fs.rm(d, { recursive: true, force: true });
  });

  /** Asserts the configuration and state are exactly as before the command. */
  async function expectUntouched(): Promise<void> {
    expect(await providerIds(root), 'the old storage must still be configured and the target left for the CLI to withdraw').toEqual(['p0', 'p1', 'p2', TARGET]);
    expect(await readState(root), 'state must be as before the command').toEqual(stateBefore);
  }

  it('should probe the target once before fetching anything, and fetch nothing from an unusable target', async () => {
    // The target's base path lies under a file, so the probe's mkdir fails
    // inside the operating system - before a single sibling part is read.
    const blocker = path.join(targetDir, 'blocker');
    await fs.writeFile(blocker, 'not a directory');
    const config = await readConfig(root);
    assert(config !== null);
    await writeConfig(root, { ...config, providers: config.providers.map((p) => (p.id === TARGET ? localProvider(TARGET, path.join(blocker, 'sub')) : p)) });
    const probe = vi.spyOn(LocalFsProvider.prototype, 'probeConnection');
    const download = vi.spyOn(LocalFsProvider.prototype, 'download');
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err.message, 'the target must be named as the storage that is not usable').toContain(`"${TARGET}" ${TARGET_UNUSABLE}`);
    expect(err.message, "the probe's own reason must reach the operator - it names where the target lives").toContain('blocker');
    expect(probe, 'the probe before the loop refuses, so no per-version probe is ever reached').toHaveBeenCalledTimes(1);
    expect(download, 'no sibling part may be fetched for a target that cannot be written').not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expectUntouched();
    // The operator declared p0 lost and nothing replaced it: every version in
    // scope is degraded, none may keep claiming to be healthy.
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
    expect(await health(root, 2)).toBe(VersionHealth.Degraded);
  });

  it('should stop at the first version when the target refuses the upload, naming step, target and cause, config untouched', async () => {
    // Captured before the spy replaces the prototype method, so siblings keep
    // uploading for real while only the target refuses.
    const originalUpload = LocalFsProvider.prototype.upload;
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args) {
      if (idOf(this) === TARGET) throw new ProviderError('disk full on the target');
      return originalUpload.call(this, ...args);
    });

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err, "the failure is the command's verdict, not the provider's error passed through").not.toBeInstanceOf(ProviderError);
    expect(err.message).toContain(TARGET);
    expect(err.message, 'the step must be named, with the part it was writing').toContain('writing shard_0.bfs.1');
    expect(err.message, "the provider's own message must reach the operator").toContain('disk full on the target');
    expect(err.message, 'version 2 was never attempted, so no failure of its part may be reported').not.toContain('shard_0.bfs.2');
    // Three lists - what moved, what failed, what was never tried - each naming
    // its versions right after the label, plainly numbered; then the advice.
    expect(err.message).toMatch(/Failed: 1\b/);
    expect(err.message).toMatch(/Not attempted: 2\b/);
    expect(err.message, 'the way out is to run the same command again once the target works').toContain('same command');
    expect(upload, 'a target that refused one version will refuse the next - the loop must stop').toHaveBeenCalledTimes(1);
    await expectUntouched();
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
    expect(await health(root, 2), 'a version not attempted is degraded too - its storage was declared lost').toBe(VersionHealth.Degraded);
  });

  it('should retry the upload once when the stored part does not match, then fail the version and stop', async () => {
    const originalGetSize = LocalFsProvider.prototype.getSize;
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');
    vi.spyOn(LocalFsProvider.prototype, 'getSize').mockImplementation(async function (this: LocalFsProvider, ref) {
      const real = await originalGetSize.call(this, ref);
      return idOf(this) === TARGET ? real - 1 : real;
    });

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err.message).toContain(TARGET);
    expect(err.message, 'the step must be named: the part did not read back as written').toContain('shard_0.bfs.1');
    expect(err.message).toContain('did not read back');
    expect(upload, 'one retry for a part that read back short, then the version fails and the loop stops').toHaveBeenCalledTimes(2);
    await expectUntouched();
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
    expect(await health(root, 2)).toBe(VersionHealth.Degraded);
  });

  it('should treat a part whose identity the target cannot confirm as a failed version', async () => {
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');
    vi.spyOn(LocalFsProvider.prototype, 'verifyShard').mockImplementation(async function (this: LocalFsProvider) {
      if (idOf(this) === TARGET) return { ok: false, reason: 'mismatch', detail: 'header names another backup' };
      return { ok: true };
    });

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err.message).toContain(TARGET);
    expect(err.message, "the provider's verdict must reach the operator").toContain('header names another backup');
    expect(upload, 'one retry, then stop').toHaveBeenCalledTimes(2);
    await expectUntouched();
  });

  it('should not upload again when the target cannot be asked about the part at all (transport fault on read-back)', async () => {
    // A storage that cannot answer `getSize` has not kept the part wrong - it
    // has stopped answering. A second multi-gigabyte upload would not change
    // that, so the version fails at once, with the storage's own words.
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');
    vi.spyOn(LocalFsProvider.prototype, 'getSize').mockImplementation(async function (this: LocalFsProvider) {
      throw new ProviderError('connection reset by peer');
    });

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err.message).toContain('connection reset by peer');
    expect(upload, 'no second upload for a storage that cannot be asked').toHaveBeenCalledTimes(1);
    await expectUntouched();
  });

  it('should take an unverifiable part on trust with a warning, as the repair migration does', async () => {
    // A storage that cannot look inside its files answers `unverifiable` - a
    // complete answer, not a mismatch (decisions.md: "Adapter nie weryfikuje
    // treści"). The size still has to match; the identity is taken on trust
    // and the operator is told so.
    const { io: trustingIo, logs } = createMockProviderIO({}, '', false);
    vi.spyOn(LocalFsProvider.prototype, 'verifyShard').mockImplementation(async function (this: LocalFsProvider) {
      if (idOf(this) === TARGET) return { ok: false, reason: 'unverifiable', detail: 'this storage does not read its files back' };
      return { ok: true };
    });

    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io: trustingIo });

    expect(await providerIds(root)).toEqual(['p1', 'p2', TARGET]);
    const warnings = logs.filter((l) => l.level === 'warn').map((l) => l.message);
    expect(
      warnings.some((m) => m.includes(TARGET) && m.includes('this storage does not read its files back')),
      `the trust taken must be said, got:\n${warnings.join('\n')}`,
    ).toBe(true);
  });

  it('should let a tampered target identity through as what it is, not as an unusable target', async () => {
    // A pinned certificate or host key that does not match is a security
    // event: it must reach the operator as TamperDetectedError, never wrapped
    // into "not usable" with the advice to run the same command again.
    vi.spyOn(LocalFsProvider.prototype, 'probeConnection').mockImplementation(async function (this: LocalFsProvider) {
      if (idOf(this) === TARGET) throw new TamperDetectedError('pinned identity does not match');
    });

    await expect(removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io })).rejects.toBeInstanceOf(TamperDetectedError);
    await expectUntouched();
  });

  it('should carry on past a sibling that merely lacks a part, and report that version as not rebuilt', async () => {
    // Version 1 has no sibling part on p1 (only p2 left: fewer than N). Version
    // 2 is intact, so it must still be rebuilt - a missing part is one
    // version's problem, not the target's.
    await fs.rm(path.join(pdirs[1] ?? '', VAULT, 'shard_1.bfs.1'));
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(upload, 'version 2 must have been rebuilt').toHaveBeenCalledTimes(1);
    expect(err.message, 'the step must be named: too few parts on the other storages').toContain('not enough parts');
    expect(err.message).toMatch(/Rebuilt: 2\b/);
    expect(err.message).toMatch(/Failed: 1\b/);
    expect(err.message, 'the version that was rebuilt is not reported as a failure').not.toContain('shard_0.bfs.2');
    await expectUntouched();
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
    expect(await shardOwner(root, 2, 0), 'version 2 must now live on the target').toBe(TARGET);
  });

  it('should stop when a sibling does not answer, since it will not answer for any version', async () => {
    // p1 refuses to authenticate - the medium is gone, not just one part on it.
    const authenticate = vi.spyOn(LocalFsProvider.prototype, 'authenticate').mockImplementation(async function (this: LocalFsProvider) {
      if (idOf(this) === 'p1') throw new ProviderError('p1 is offline');
    });
    const download = vi.spyOn(LocalFsProvider.prototype, 'download');
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload');

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(err.message, 'the storage that did not answer must be named').toContain('"p1" did not answer');
    expect(err.message).toContain('p1 is offline');
    // Stop, not continue: the sibling is asked once, version 2 is never tried.
    expect(
      authenticate.mock.contexts.filter((self) => idOf(self) === 'p1'),
      'a storage that did not answer is not asked again for the next version',
    ).toHaveLength(1);
    expect(download.mock.contexts.filter((self) => idOf(self) === 'p2').length, 'the other sibling is read at most for the first version').toBeLessThanOrEqual(1);
    expect(err.message).toMatch(/Not attempted: 2\b/);
    expect(upload, 'nothing can be rebuilt without the sibling').not.toHaveBeenCalled();
    await expectUntouched();
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
    expect(await health(root, 2)).toBe(VersionHealth.Degraded);
  });

  it('should drop the old storage from the config only after every version was rebuilt and confirmed', async () => {
    const getSize = vi.spyOn(LocalFsProvider.prototype, 'getSize');
    const verifyShard = vi.spyOn(LocalFsProvider.prototype, 'verifyShard');

    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io });

    expect(await providerIds(root)).toEqual(['p1', 'p2', TARGET]);
    const measuredOnTarget = getSize.mock.contexts.filter((self) => idOf(self) === TARGET).length;
    const confirmedOnTarget = verifyShard.mock.contexts.filter((self) => idOf(self) === TARGET).length;
    expect(measuredOnTarget, 'every rebuilt part is measured on the target').toBe(2);
    expect(confirmedOnTarget, 'every rebuilt part has its identity confirmed on the target').toBe(2);
    expect(await health(root, 1)).toBe(VersionHealth.Healthy);
    expect(await health(root, 2)).toBe(VersionHealth.Healthy);
  });

  it('should keep a partially loaded target and finish on the next run without rebuilding what already moved', async () => {
    // The target takes version 1 and then fails; the run reports a partial
    // rebuild. Once the target works again, the same command finishes the job
    // - and does not upload version 1 a second time.
    const originalUpload = LocalFsProvider.prototype.upload;
    let targetUploads = 0;
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args) {
      if (idOf(this) === TARGET) {
        targetUploads += 1;
        if (targetUploads === 2) throw new ProviderError('target went away');
      }
      return originalUpload.call(this, ...args);
    });

    const err = await rebuildFailure(root, io);

    expect(err).toBeInstanceOf(BfsError);
    expect(err.message, 'the version that failed is reported by its part').toContain('writing shard_0.bfs.2');
    expect(err.message).toContain('target went away');
    expect(err.message, 'the version that moved is not reported as a failure').not.toContain('shard_0.bfs.1');
    expect(err.message).toMatch(/Rebuilt: 1\b/);
    expect(err.message).toMatch(/Failed: 2\b/);
    await expectUntouched();
    expect(await shardOwner(root, 1, 0), 'version 1 stays on the target').toBe(TARGET);

    upload.mockRestore();
    const uploadAgain = vi.spyOn(LocalFsProvider.prototype, 'upload');
    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io });

    expect(uploadAgain, 'only the version that had not moved is rebuilt on the retry').toHaveBeenCalledTimes(1);
    expect(await providerIds(root)).toEqual(['p1', 'p2', TARGET]);
    expect(await health(root, 1)).toBe(VersionHealth.Healthy);
    expect(await health(root, 2)).toBe(VersionHealth.Healthy);
  });
});

describe('provider remove --strategy rebuild after a recovery whose locations are not yet confirmed', () => {
  let root: string;
  let pdirs: string[];
  let targetDir: string;
  let io: ProviderIO;

  beforeEach(async () => {
    // An operator at the terminal who confirms the recovered locations when asked.
    io = createMockProviderIO({ [t('push_confirm_recovered_locations')]: 'true' }, '', true).io;
    ({ root, pdirs, targetDir } = await setupVault({ data_shards: 2, parity_shards: 1 }, io, 1));
    await writeState(root, { ...(await readState(root)), locations_confirmed: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs, targetDir]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should leave the locations unconfirmed when the rebuild failed, and confirm them only after it succeeded', async () => {
    const originalUpload = LocalFsProvider.prototype.upload;
    const upload = vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args) {
      if (idOf(this) === TARGET) throw new ProviderError('disk full on the target');
      return originalUpload.call(this, ...args);
    });

    await rebuildFailure(root, io);

    expect((await readState(root)).locations_confirmed, 'a rebuild that did not complete has not confirmed anything').toBe(false);

    upload.mockRestore();
    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: TARGET, rebuildScope: 'all', io });

    expect((await readState(root)).locations_confirmed, 'a completed rebuild is the confirmation').toBe(true);
    expect(await providerIds(root)).toEqual(['p1', 'p2', TARGET]);
  });
});

describe('provider remove --strategy rebuild with a rotted but surplus sibling (positive control)', () => {
  let root: string;
  let pdirs: string[];
  let targetDir: string;
  let io: ProviderIO;

  // 2+2 has four storages p0..p3, so the spare target takes the next id.
  const SPARE = 'p4';

  beforeEach(async () => {
    io = createMockProviderIO({}, '', false).io;
    ({ root, pdirs, targetDir } = await setupVault({ data_shards: 2, parity_shards: 2 }, io, 1, SPARE));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs, targetDir]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should still succeed and commit the config, stamping the version degraded for the rot it read', async () => {
    // With 2+2 there are three siblings and one of them rotted: enough sound
    // parts remain, so the rebuild goes through; the rot is a finding about
    // the version, recorded as degraded, not a failure of this command.
    await rotShardPayload(path.join(pdirs[1] ?? '', VAULT, 'shard_1.bfs.1'));

    await removeProvider(root, REMOVED, { strategy: 'rebuild', targetProviderId: SPARE, rebuildScope: 'all', io });

    expect(await providerIds(root)).toEqual(['p1', 'p2', 'p3', SPARE]);
    expect(await shardOwner(root, 1, 0)).toBe(SPARE);
    expect(await health(root, 1)).toBe(VersionHealth.Degraded);
  });
});
