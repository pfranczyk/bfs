import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
// Side-effect import: registers the built-in local adapter in the global registry.
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { confirmRecoveredLocations } from '../../src/vault/recovered-locations.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// A run with nobody at the keyboard answers "no" to every yes/no question by
// itself. Reading that as the operator's decision leads nowhere: "cancelled"
// invites a retry that ends identically, and telling such a run to check the
// recovered locations and try again points at a gate only a confirmed push, a
// confirmed heal, or a fresh `bfs recovery --trust-locations` ever opens. So
// each site below tells that run what it could not confirm, and what settles it.
//
// Each site below owns a decision a command line CAN carry, so a run without an
// operator has to name that one instead - and name it as something the operator
// can type. A flag alone is not that: `--trust-locations` belongs to
// `bfs recovery`, and there is no `bfs push --trust-locations` to reach for.
//
// These layers read the mode from ProviderIO.interactive, which is false under
// --ci and equally false with no terminal attached. That is deliberate and does
// not extend to the CLI's own prompts: those follow the declaration alone, so a
// run at a pipe still renders its menus (smoke B10c/B10d read one).
//
// Each refusal is paired with a control at a terminal, where the operator really
// did decline. The cancellations are shared: `push_cancelled` is thrown from
// four places in src/vault/push-pipeline.ts and `pull_cancelled` from two in
// src/vault/vault-manager.ts, so rewriting either string would satisfy the
// refusal assertions while putting the wrong advice on their siblings.

const VAULT_NAME = 'honest';

/** Sandbox holding the working directory and the three storage directories. */
async function sandbox(): Promise<{ root: string; dirs: string[] }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ci-honest-'));
  const root = path.join(base, 'work');
  const dirs = [path.join(base, 'p0'), path.join(base, 'p1'), path.join(base, 'p2')];
  await fs.mkdir(root, { recursive: true });
  for (const d of dirs) await fs.mkdir(d, { recursive: true });
  return { root, dirs };
}

/** IO for a run nobody is watching - the state --ci and a closed stdin share. */
function noOperatorIO(): ProviderIO {
  return createMockProviderIO({}, process.cwd(), false).io;
}

/** IO for a run at a terminal. Its confirm() answers "no" - a real decline. */
function decliningOperatorIO(): ProviderIO {
  return createMockProviderIO().io;
}

function localProviders(dirs: string[]): ProviderConfig[] {
  return dirs.map((dir, i) => ({ id: `p${i}`, type: 'local', adapterPackage: null, config: { path: dir } }));
}

/** Stands up a `--no-enc` 2/1 vault on three local directories and pushes v1. */
async function setupVault(root: string, dirs: string[]): Promise<void> {
  await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
  await init(root, {
    vault_name: VAULT_NAME,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: localProviders(dirs),
    push_mode: PushMode.NewVersion,
    io: decliningOperatorIO(),
  });
  await push(root, { io: decliningOperatorIO() });
}

describe('a run with no operator explains what it cannot confirm', () => {
  let base = '';
  let root = '';
  let dirs: string[] = [];

  beforeEach(async () => {
    const sb = await sandbox();
    root = sb.root;
    dirs = sb.dirs;
    base = path.dirname(root);
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });

  it('should send the operator to `bfs recovery --trust-locations` when the recovered locations cannot be confirmed', async () => {
    await setupVault(root, dirs);
    const config = await readConfig(root);
    assert(config !== null, 'the vault set up above must have a config on disk');

    await expect(confirmRecoveredLocations(config, noOperatorIO())).rejects.toThrow(/bfs recovery[\s\S]*--trust-locations/);
  });

  // The pair matters more here than anywhere else in this file. An operator who
  // has just refused to vouch for the recovered locations must not be handed the
  // command that pre-approves them: that would answer a security decision by
  // offering to reverse it. So the advice belongs to the run with nobody in it,
  // and only to that one.
  it('should not offer --trust-locations to an operator who declined the locations', async () => {
    await setupVault(root, dirs);
    const config = await readConfig(root);
    assert(config !== null, 'the vault set up above must have a config on disk');

    const err = await confirmRecoveredLocations(config, decliningOperatorIO()).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, 'a declined location gate must not let the caller through');
    expect(String(err)).not.toMatch(/--trust-locations/);
  });

  it('should name --yes instead of reporting a cancelled push when the version switch cannot be confirmed', async () => {
    await setupVault(root, dirs);
    await push(root, { io: decliningOperatorIO() });
    const state = await readState(root);
    await writeState(root, { ...state, working_version: 1 });

    // `--yes` carries this consent up front, so a run with nobody in it names
    // that flag rather than reporting a decision nobody made. Unlike `bfs pull`,
    // the way through does NOT overwrite the working directory - push always
    // creates a new version, so `--yes` waives only the confirmation, never the
    // source of truth.
    const err = await push(root, { io: noOperatorIO() }).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, 'a push that cannot confirm the version switch must not succeed');
    expect(String(err)).toMatch(/--yes/);
    expect(String(err)).not.toMatch(/cancelled/i);
    // ...and never `bfs pull --yes`: that flag settles a different gate by
    // overwriting the working directory, the single source of truth. The push
    // refusal must name its OWN flag, so the advice a cron follows is safe.
    expect(String(err)).not.toMatch(/pull/);
  });

  it('should let --yes carry an unattended push past the version switch', async () => {
    await setupVault(root, dirs);
    await push(root, { io: decliningOperatorIO() });
    const before = await readState(root);
    await writeState(root, { ...before, working_version: 1 });

    // The flag's whole point: a run with no operator finishes the work instead
    // of refusing. Consent is orthogonal to presence - a non-interactive io plus
    // `--yes` proceeds, where the same io without it refuses (the test above).
    const result = await push(root, { io: noOperatorIO(), yes: true });

    expect(result.version).toBe(before.latest_version + 1);
    const after = await readState(root);
    expect(after.latest_version).toBe(before.latest_version + 1);
  });

  it('should let --yes skip the version-switch confirmation at a terminal too', async () => {
    await setupVault(root, dirs);
    await push(root, { io: decliningOperatorIO() });
    const before = await readState(root);
    await writeState(root, { ...before, working_version: 1 });

    // A/B against the plain-cancellation control below: the same declining io
    // that cancels without the flag proceeds with it, so `--yes` is pre-consent
    // - the confirmation is never put - not a presence signal.
    const result = await push(root, { io: decliningOperatorIO(), yes: true });

    expect(result.version).toBe(before.latest_version + 1);
  });

  it('should not let --yes waive the recovered-locations gate', async () => {
    await setupVault(root, dirs);
    const state = await readState(root);
    // A backup whose locations came from an untrusted recovery map. The gate
    // guarding the first write after recovery is a security decision, not the
    // version-switch confirmation `--yes` consents to - so the flag must not
    // carry a no-operator run past it. Scopes `--yes` to the one gate it names.
    await writeState(root, { ...state, locations_confirmed: false });

    const err = await push(root, { io: noOperatorIO(), yes: true }).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, '--yes must not push past the recovered-locations gate');
    expect(String(err)).toMatch(/bfs recovery[\s\S]*--trust-locations/);
  });

  it('should keep the plain cancellation when an operator really declined the push', async () => {
    await setupVault(root, dirs);
    await push(root, { io: decliningOperatorIO() });
    const state = await readState(root);
    await writeState(root, { ...state, working_version: 1 });

    const err = await push(root, { io: decliningOperatorIO() }).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, 'a declined push must not succeed');
    expect(String(err)).toMatch(/cancelled/i);
    expect(String(err)).not.toMatch(/bfs pull --yes/);
  });

  it('should name --yes instead of reporting a cancelled pull when the overwrite cannot be confirmed', async () => {
    await setupVault(root, dirs);

    const err = await pull(root, { io: noOperatorIO() }).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, 'a pull that cannot confirm the overwrite must not succeed');
    expect(String(err)).toMatch(/--yes/);
    // ...and only --yes. The gate also lets --force through, but --force empties
    // the working directory of everything the backup does not contain, which is
    // not what a question about overwriting a version asked. Offering it here as
    // the equivalent turns a consent into a deletion the operator never chose.
    expect(String(err)).not.toMatch(/--force/);
  });

  it('should keep the plain cancellation when an operator really declined the pull', async () => {
    await setupVault(root, dirs);

    const err = await pull(root, { io: decliningOperatorIO() }).then(
      () => null,
      (e: unknown) => e,
    );

    assert(err !== null, 'a declined pull must not succeed');
    expect(String(err)).toMatch(/cancelled/i);
    expect(String(err)).not.toMatch(/--yes/);
  });

  it('should carry out the advice: the same pull runs once --yes is supplied', async () => {
    await setupVault(root, dirs);

    await expect(pull(root, { io: noOperatorIO(), yes: true })).resolves.toBeDefined();
  });
});
