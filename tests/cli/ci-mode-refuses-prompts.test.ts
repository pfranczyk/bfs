import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// `--ci` promises that the run asks nothing, and the promise binds both layers
// that ask: the adapter's (ProviderIO.ask/askSecret/choose refuse) and the CLI's
// own prompts in `prune`, `provider remove` and `recovery`. A question put in
// such a run never resolves - the event loop empties and the process waits until
// something kills it.
//
// The prompt module is replaced with a sentinel here, so reaching it at all
// fails the test. That is deliberate: a guard living only inside the prompt
// helper would be invisible to this file, and an incomplete command must be
// refused BEFORE the command does any work, not caught on its way into the
// question. The helper's own guard is held by tests/cli/prompt-ci-backstop.
//
// A real terminal is what makes the difference observable end to end (a pipe is
// non-interactive whatever the code does), so the binding proof lives in
// scripts/cli-e2e/scenarios/113-ci-never-prompts. This file pins the reason.

const PROMPT_SENTINEL = 'PROMPT_REACHED';

vi.mock('../../src/cli/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/prompt.js')>();
  return {
    ...actual,
    promptWithRawMode: (): never => {
      throw new Error(PROMPT_SENTINEL);
    },
  };
});

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn(), removeProvider: vi.fn(), prune: vi.fn(), assertPruneKeepsARestorableVersion: vi.fn() }));

import { readConfig, writeConfig } from '../../src/vault/config.js';
import { assertPruneKeepsARestorableVersion, listVersions, prune, removeProvider } from '../../src/vault/vault-manager.js';

/** One manifest per version, enough for prune/provider-remove to see them. */
function manifests(versions: number[]): unknown[] {
  return versions.map((version) => ({ version, health: 'healthy', shards: [{ shard_index: 2, provider_id: 'dysk-3' }] }));
}

/** Runs a command and reports what came out, without letting anything escape. */
async function runCapturing(tokens: string[]): Promise<{ errors: string; logs: string; escaped: string }> {
  const cap = captureConsole();
  let escaped = '';
  try {
    await runCmd(tokens);
  } catch (err) {
    escaped = err instanceof Error ? err.message : String(err);
  } finally {
    cap.restore();
  }
  return { errors: cap.errors.join('\n'), logs: cap.logs.join('\n'), escaped };
}

describe('a run that declared --ci never reaches a CLI prompt', () => {
  beforeEach(() => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    vi.mocked(listVersions).mockResolvedValue(manifests([1, 2]) as never);
    vi.mocked(removeProvider).mockResolvedValue(undefined as never);
    vi.mocked(prune).mockResolvedValue(undefined as never);
    vi.mocked(assertPruneKeepsARestorableVersion).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should refuse `prune` with no versions named instead of asking which to delete', async () => {
    const r = await runCapturing(['--ci', 'prune']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(`${r.errors}${r.escaped}`).toMatch(/--keep-last/);
    expect(prune).not.toHaveBeenCalled();
  });

  it('should refuse `prune <range>` with no --yes instead of asking for confirmation', async () => {
    const r = await runCapturing(['--ci', 'prune', '1']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(`${r.errors}${r.escaped}`).toMatch(/--yes/);
    expect(prune).not.toHaveBeenCalled();
  });

  // --keep-last picks the versions a different way but reaches the same
  // confirmation, so a guard written around the range argument alone would leave
  // this one hanging.
  it('should refuse `prune --keep-last <n>` with no --yes instead of asking for confirmation', async () => {
    const r = await runCapturing(['--ci', 'prune', '--keep-last', '1']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(`${r.errors}${r.escaped}`).toMatch(/--yes/);
    expect(prune).not.toHaveBeenCalled();
  });

  it('should carry out `prune <range> --yes`, so the refusal names a way through', async () => {
    const r = await runCapturing(['--ci', 'prune', '1', '--yes']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(prune).toHaveBeenCalledTimes(1);
  });

  it('should refuse `provider remove` with no name instead of listing the storage', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(`${r.errors}${r.escaped}`).toMatch(/provider remove/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  it('should refuse `provider remove <id>` with no --strategy instead of asking for one', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(`${r.errors}${r.escaped}`).toMatch(/--strategy/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  it('should carry out `provider remove <id> --strategy remove --yes`, so the refusal names a way through', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    expect(removeProvider).toHaveBeenCalledTimes(1);
  });

  // A completeness check that runs before the name has been looked up answers a
  // typo with a flag to add - and the operator adds it to a command that was
  // never going to work. Which storage is settled first, everything else after.
  it('should report a storage name that does not exist as such, not as a missing flag', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'nosuchdisk', '--strategy', 'remove']);

    expect(`${r.errors}${r.escaped}`).toMatch(/nosuchdisk/);
    expect(`${r.errors}${r.escaped}`).not.toMatch(/--yes/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  // `recovery` is the third command whose own prompts predate the mode: with no
  // --bootstrap it goes straight to the adapter-type menu. A fix aimed at prune
  // and provider remove alone would leave this one waiting.
  it('should refuse `recovery` with nothing to bootstrap from instead of opening the adapter menu', async () => {
    const r = await runCapturing(['--ci', 'recovery']);

    expect(`${r.errors}${r.escaped}`).not.toContain(PROMPT_SENTINEL);
    // Refusing is only half of it: a run that stops without naming what it is
    // short of leaves the operator exactly where the prompt would have.
    expect(`${r.errors}${r.escaped}`).toMatch(/--provider|--bootstrap/);
  });
});

describe('a --ci run names the secret it is missing before it starts working', () => {
  const encrypted = makeConfig({ encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' as const } });

  beforeEach(() => {
    vi.mocked(readConfig).mockResolvedValue(encrypted as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    vi.mocked(listVersions).mockResolvedValue(manifests([1]) as never);
    vi.mocked(removeProvider).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // The relocate path hands the new address to the adapter and validates it, and
  // only then reaches for the password of an encrypted backup. Under --ci that
  // password can never arrive, so the adapter was put to work to reach a refusal
  // the command line already implied - and the refusal that does come out names
  // no flag the operator could add.
  //
  // Both halves are asserted, because either alone lets a wrong fix through: a
  // rewritten message with the guard left in place would still configure first,
  // and a moved guard with the old message would still leave the operator
  // without a flag to add. The refusal is read off both channels - whether it
  // travels as a printed error or as a throw out of the action is presentation,
  // not behaviour.
  it('should name --password before putting the adapter to work', async () => {
    const configuring = vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags');

    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'relocate', '--path', '/tmp/relocated']);

    expect(`${r.errors}${r.escaped}`).toMatch(/--password(?!-)/);
    // ...and not by teaching the one message every unanswerable question shares to
    // recite --password. That sentence belongs to ask/askSecret/choose alike, so
    // putting a provider-remove flag in it hands the same advice to a prompt
    // about a host key or a vault name. "needs an answer to" is its own wording
    // and appears nowhere else, so this pins the generic message staying generic.
    expect(`${r.errors}${r.escaped}`).not.toMatch(/needs an answer to/);
    expect(configuring).not.toHaveBeenCalled();
    expect(removeProvider).not.toHaveBeenCalled();
  });

  // The secret can arrive by file too - the form CI prefers, since it keeps the
  // password out of the process list. A guard that only looks at --password
  // turns a complete command line away.
  it('should accept --password-file as the secret the command line carries', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'relocate', '--path', '/tmp/relocated', '--password-file', '/tmp/nonexistent-pw']);

    expect(`${r.errors}${r.escaped}`).not.toMatch(/--password(?!-)/);
  });

  // `remove` drops the storage without touching a byte of it, so it needs no
  // password at all. A guard keyed on "encrypted backup + no secret" refuses a
  // command that is complete.
  it('should not ask a --strategy remove to carry a password it never uses', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes']);

    expect(`${r.errors}${r.escaped}`).not.toMatch(/--password/);
    expect(removeProvider).toHaveBeenCalledTimes(1);
  });

  // `rebuild` reaches for the password even earlier than `relocate` - before it
  // has checked --target - so a guard dropped into the relocate branch alone
  // leaves this one refusing without naming a flag.
  it('should name --password for a rebuild too, not only for a relocate', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'rebuild', '--target', 'dysk-2']);

    expect(`${r.errors}${r.escaped}`).toMatch(/--password(?!-)/);
    expect(`${r.errors}${r.escaped}`).not.toMatch(/needs an answer to/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  // With the target missing too, the missing target is what the operator should
  // hear about: the rebuild has no destination, and no password would give it
  // one. The order is easy to lose - the command's own rebuild branch reaches
  // for the password before it looks at --target.
  it('should name the missing --target ahead of the password when both are absent', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'rebuild']);

    expect(`${r.errors}${r.escaped}`).toMatch(/--target/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  // An empty value is not a secret. Letting it through the guard hands it to
  // resolvePassword and the run dies further down with the generic "nobody to
  // ask" message - the exact outcome the guard is here to replace.
  it('should treat an empty --password as no password at all', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'relocate', '--path', '/tmp/relocated', '--password', '']);

    expect(`${r.errors}${r.escaped}`).toMatch(/--password(?!-)/);
    expect(`${r.errors}${r.escaped}`).not.toMatch(/needs an answer to/);
    expect(removeProvider).not.toHaveBeenCalled();
  });

  it('should carry out the same relocate once --password is supplied', async () => {
    const r = await runCapturing(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'relocate', '--path', '/tmp/relocated', '--password', 'secret123']);

    expect(`${r.errors}${r.escaped}`).not.toMatch(/--password(?!-)/);
    expect(removeProvider).toHaveBeenCalledTimes(1);
  });
});
