// Interactive `bfs init` - provider connectivity probe + retry.
//
// Right after a provider's configureInteractive() returns, the init action
// instantiates the provider and validates the medium with a full storage
// round-trip via probeConnection() inside a retry loop. authenticate() alone is
// too weak a gate: a provider can authenticate (e.g. FTP with a valid
// host/port/login) yet have an unusable base path. probeConnection() exercises
// the medium end to end, so it is the acceptance gate for the chosen medium. On
// a ProviderError it warns on the CLI's warning channel and asks io.choose with three options in
// a fixed order:
//   [0] RETRY    - re-probe the same config
//   [1] RE-ENTER - re-run configureInteractive for that provider
//   [2] ABORT    - clean cancellation, no stack dump
// RETRY->success or RE-ENTER->success completes init; ABORT ends cleanly. This
// keeps a connection failure - transient, or a typo in host/port/password/path
// - recoverable in place, instead of aborting the whole command and discarding
// every value the operator already entered.
//
// The recovery option is selected by INDEX in the offered list (documented
// order RETRY/RE-ENTER/ABORT), so these tests stay independent of the prompt's
// i18n wording (keys probe_connection, probe_failed_prompt,
// probe_choice_retry / _reenter / _abort in src/i18n/en.ts + pl.ts).

import { ExitPromptError } from '@inquirer/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityDeclinedError, ProviderError } from '../../src/core/errors.js';
import * as providerMod from '../../src/providers/provider.js';
import { providerRegistry } from '../../src/providers/provider.js';
import type { ProviderIO, StorageProvider } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

// The interactive path records every storage but the last through
// admitInitProvider; these tests are about the probe loop, so both vault calls
// are stubs.
vi.mock('../../src/vault/vault-manager.js', () => ({ init: vi.fn(), admitInitProvider: vi.fn() }));
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
    Separator: class {
      type = 'separator';
    },
  },
  Separator: class {
    type = 'separator';
  },
}));

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import inquirer from 'inquirer';
import { init } from '../../src/vault/vault-manager.js';

const mockInit = vi.mocked(init);
const mockPrompt = vi.mocked(inquirer.prompt);

const PROBE_TYPE = 'mockprobe';

/**
 * Stand-in for the contract's IdentityDeclinedError as an adapter shipped in its
 * own package sees it: the same class name, but a different copy of the class
 * (the adapter imports `bfs-vault/provider` from its own dependency tree), so
 * `instanceof` against the CLI's copy fails. A subclass of it, as an adapter
 * would write one, keeps the name further up the prototype chain.
 */
class IdentityDeclinedErrorCopy extends Error {}
Object.defineProperty(IdentityDeclinedErrorCopy, 'name', { value: 'IdentityDeclinedError' });
class ForeignCopyDecline extends IdentityDeclinedErrorCopy {}

interface ProbeState {
  /** One outcome consumed per probeConnection() call: 'fail' throws, 'ok' resolves. */
  attempts: string[];
  /**
   * Count of probeConnection() invocations - the acceptance gate. One scripted
   * outcome from `attempts` is consumed per call.
   */
  probeCalls: number;
  /**
   * Count of authenticate() invocations. Kept separate (and never the gate) to
   * prove authenticate() alone does NOT decide provider acceptance - it is a
   * lightweight connect/login, not a round-trip check.
   */
  authCalls: number;
  /**
   * Vault names passed to setVaultName(), in call order. probeConnection()
   * resolves its target path from the vault name, so the gate MUST set it
   * first; recording the calls lets a test prove init wired setVaultName()
   * before probing (a dropped call breaks every real provider).
   */
  setVaultNames: string[];
  configCalls: number;
  /**
   * Message the thrown ProviderError carries on a 'fail' outcome. Lets a test
   * prove the recovery loop is message-agnostic (fires for ANY ProviderError,
   * not just a specific "530 max connections" string). Defaults below.
   */
  failMessage?: string;
  /**
   * One outcome consumed per validateConfig() call: 'invalid' returns a
   * non-empty error list, anything else returns []. Lets a test prove init
   * runs validateConfig() as a gate (parity with provider-add) - a config that
   * fails validation must surface the recovery prompt BEFORE probing, not be
   * silently accepted. Defaults to always-valid when undefined.
   */
  validateAttempts?: string[];
  /** Count of validateConfig() invocations - never the probe gate. */
  validateCalls: number;
  /**
   * One outcome consumed per configureInteractive() call: 'fail' throws a
   * ProviderError (an FTPS/SSH server that does not answer while the adapter
   * reads its identity, or the adapter's own limit on going back), 'cancel'
   * throws ExitPromptError (Ctrl+C), 'decline' throws IdentityDeclinedError (the
   * operator refused the server identity), anything else returns a config.
   * Defaults to always-succeeding when undefined.
   */
  configureAttempts?: string[];
}

/**
 * Registers a mock provider type on the global singleton registry. Its
 * probeConnection() follows the scripted `attempts` (extra calls past the array
 * succeed) and is the acceptance gate; authenticate() is a no-op that never
 * gates. configureInteractive() needs no inquirer prompt (it returns a config
 * or throws as `configureAttempts` scripts), so the per-provider prompt budget
 * is only id + type.
 */
function registerProbeProvider(state: ProbeState): void {
  providerRegistry.register(PROBE_TYPE, {
    lang: 'en',
    displayName: 'Mock Probe',
    create: () =>
      ({
        // Lightweight connect/login - NOT the acceptance gate. Never throws.
        async authenticate(): Promise<void> {
          state.authCalls += 1;
          return;
        },
        // Full storage round-trip - THIS is the acceptance gate. One scripted
        // outcome consumed per call; 'fail' throws a ProviderError.
        async probeConnection(): Promise<void> {
          const outcome = state.attempts[state.probeCalls] ?? 'ok';
          state.probeCalls += 1;
          if (outcome === 'fail') throw new ProviderError(state.failMessage ?? 'mock probe round-trip failed');
        },
        setVaultName(name: string): void {
          state.setVaultNames.push(name);
        },
        async configureInteractive(_io: ProviderIO): Promise<Record<string, unknown>> {
          const outcome = state.configureAttempts?.[state.configCalls] ?? 'ok';
          state.configCalls += 1;
          if (outcome === 'fail') throw new ProviderError('FTP operation failed on nas.example.com:21: connect ECONNREFUSED');
          if (outcome === 'cancel') throw new ExitPromptError('User force closed the prompt with SIGINT');
          if (outcome === 'decline') throw new IdentityDeclinedError('FTPS certificate for nas.example.com:21 was not trusted - refusing to connect.');
          if (outcome === 'decline-foreign') throw new ForeignCopyDecline('Server identity of nas.example.com was not trusted - refusing to connect.');
          return { marker: state.configCalls };
        },
        // Config-shape gate run BEFORE the round-trip probe. One scripted
        // outcome consumed per call; 'invalid' returns a non-empty error list.
        // Never gates the probe - a separate acceptance step.
        validateConfig(): string[] {
          const outcome = state.validateAttempts?.[state.validateCalls] ?? 'ok';
          state.validateCalls += 1;
          return outcome === 'invalid' ? ['mock validation error'] : [];
        },
        // Provider-API completeness surface (v2) - unused by the probe path.
        usesSidecar: () => false,
        uploadHeaderSidecar: async () => {},
        downloadHeaderSidecar: async () => null,
        verifyShard: async () => ({ ok: true }),
      }) as unknown as StorageProvider,
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

/**
 * Installs a ProviderIO (via spying on createCliProviderIO) whose `choose`
 * returns the option at `pickIndex` - picking the recovery action by its
 * documented position (0=RETRY, 1=RE-ENTER, 2=ABORT) rather than its
 * not-yet-translated text. Records warn() lines and every choose() call so a
 * test can assert the recovery prompt was actually presented.
 */
function installProbeIO(pickIndex: number): { warns: string[]; chooseCalls: Array<{ message: string; options: string[] }> } {
  const warns: string[] = [];
  const chooseCalls: Array<{ message: string; options: string[] }> = [];
  const io: ProviderIO = {
    lang: 'en',
    workDir: '/work',
    ask: vi.fn(async () => ''),
    askSecret: vi.fn(async () => ''),
    confirm: vi.fn(async () => false),
    async choose(message: string, options: string[]): Promise<string> {
      chooseCalls.push({ message, options });
      return options[pickIndex] ?? options[0] ?? '';
    },
    info: vi.fn(),
    debug: vi.fn(),
    warn: (m: string) => {
      warns.push(m);
    },
    progress: vi.fn(),
  };
  vi.spyOn(providerMod, 'createCliProviderIO').mockReturnValue(io);
  return { warns, chooseCalls };
}

/**
 * Scripts an interactive `bfs init myvault` for a 2/1 scheme with three mock
 * providers. The prompt order is: encryption, compression, scheme, push mode,
 * RAM, then per provider (id, type) - push mode and RAM come before the storages
 * because the first storage that passes is written to config.json with them.
 * Encryption + compression are answered "no" via inquirer, not via flags.
 */
function scriptInteractivePrompts(): void {
  mockPrompt
    .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
    .mockResolvedValueOnce({ compressEnabled: false } as never) // compression
    .mockResolvedValueOnce({ dataShardsStr: '2', parityShardsStr: '1' } as never) // scheme
    .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never) // push mode
    .mockResolvedValueOnce({ maxRamStr: '1024' } as never) // RAM
    .mockResolvedValueOnce({ id: 'p1' } as never) // provider 1 id
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never) // provider 1 type
    .mockResolvedValueOnce({ id: 'p2' } as never)
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never)
    .mockResolvedValueOnce({ id: 'p3' } as never)
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never);
}

describe('interactive init - provider connectivity probe + retry', () => {
  let capture: ReturnType<typeof captureConsole>;
  // A real, empty working directory per run: the command scans it and the
  // re-init guard inspects it, and these tests are about the probe loop - not
  // about how a fake filesystem answers whichever call the guard happens to use.
  let root: string;

  /** Runs `bfs <tokens>` with `--cwd` pointing at this test's working directory. */
  function runInRoot(tokens: string[]): ReturnType<typeof runCmd> {
    return runCmd(['--cwd', root, ...tokens]);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-probe-'));
    capture = captureConsole();
    mockInit.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    capture.restore();
    // mockReset (not just clearAllMocks) drains the mockResolvedValueOnce queue:
    // a test that aborts early (ABORT path) consumes fewer prompts than it
    // scripted, and leftover queued answers would otherwise bleed into the next
    // test and misalign its prompt sequence.
    mockPrompt.mockReset();
    mockInit.mockReset();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    // Drop the mock provider type so other suites see a clean registry.
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(PROBE_TYPE);
    // Last, so a removal that throws cannot skip the mock and registry resets above.
    await fs.rm(root, { recursive: true, force: true });
  });

  it('RETRY: should re-probe the same config and complete init after a transient failure', async () => {
    // First provider's probe round-trip fails once, then succeeds on retry; the
    // other two succeed on their first probe.
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(0); // pick RETRY (index 0)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    // The recovery choice prompt must actually have been presented.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // Probe re-ran the SAME config: the failing provider was probed twice
    // (fail -> ok), and configureInteractive ran exactly once per provider
    // (no re-entry on RETRY).
    expect(state.probeCalls).toBeGreaterThanOrEqual(4); // 3 providers + 1 retry
    expect(state.configCalls).toBe(3);
    // init completed (no abort) and vault-manager.init was reached.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('RE-ENTER: should re-run configureInteractive and complete init with new config', async () => {
    // The first provider's first probe fails; choosing RE-ENTER re-runs its
    // configureInteractive, and the next probe succeeds.
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // configureInteractive ran again for the failing provider: 3 base configs
    // + at least one re-entry.
    expect(state.configCalls).toBeGreaterThan(3);
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('ABORT: should end via clean cancellation, not an uncaught throw', async () => {
    const state: ProbeState = { attempts: ['fail', 'fail', 'fail'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(2); // pick ABORT (index 2)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    // The recovery prompt was shown and the operator chose abort.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // Clean cancellation: runCmd maps CommandAbort -> 'abort' and prompt
    // cancellation -> 'cancelled'. Either is an intentional, handled outcome -
    // what must NOT happen is an unexpected uncaught error type (runCmd rethrows
    // those) or silently reaching vault-manager.init() despite the abort.
    expect(['abort', 'cancelled']).toContain(result);
    expect(mockInit).not.toHaveBeenCalled();
  });

  // Message-agnosticism: the recovery loop must fire for ANY ProviderError,
  // regardless of the failure text. This guards against a fix special-cased to
  // one symptom (e.g. "530 max connections") - every real FTP wrong-field
  // failure must surface the same recoverable prompt. Each case fails the first
  // probe with a distinct, field-specific message, then RE-ENTER (index 1)
  // re-runs configureInteractive and the next probe succeeds; the recovery
  // prompt must have been shown and init must complete.
  const FAILURE_MESSAGES: Array<{ field: string; message: string }> = [
    { field: 'wrong host (ENOTFOUND-style)', message: 'getaddrinfo ENOTFOUND no-such-host.invalid' },
    { field: 'wrong port (ECONNREFUSED-style)', message: 'connect ECONNREFUSED 192.0.2.1:9921' },
    { field: 'wrong password (530 login incorrect)', message: '530 Login incorrect.' },
    { field: 'wrong path (550 no such directory)', message: '550 No such file or directory.' },
  ];

  it.each(FAILURE_MESSAGES)('RE-ENTER recovery fires for any ProviderError - $field', async ({ message }) => {
    // First probe of the first provider fails with the field-specific message;
    // after RE-ENTER its next probe succeeds. The other two succeed immediately.
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], failMessage: message };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    // The recovery choice prompt was presented regardless of the failure text.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // RE-ENTER re-ran configureInteractive for the failing provider.
    expect(state.configCalls).toBeGreaterThan(3);
    // init completed after recovery.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // Regression: init MUST gate provider acceptance on probeConnection() - the full
  // storage round-trip - not on authenticate(). A provider that authenticates
  // (valid host/port/login) but has an unusable base path fails the round-trip;
  // it must NOT be silently accepted. Here the first provider's first probe
  // fails and the second (after RE-ENTER) succeeds - recovery is driven entirely
  // by the probeConnection() outcome. authCalls is deliberately NOT the gate:
  // whether authenticate() ran or not is irrelevant to acceptance.
  it('should gate provider acceptance on probeConnection round-trip, not authenticate', async () => {
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    // The probeConnection failure surfaced the recovery prompt.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // The round-trip gate ran across all providers plus the re-probe.
    expect(state.probeCalls).toBeGreaterThanOrEqual(4);
    // The gate wired the vault name before probing - a dropped setVaultName()
    // would leave probeConnection() unable to resolve its path on real providers.
    expect(state.setVaultNames).toContain('myvault');
    // RE-ENTER re-ran configureInteractive for the failing provider.
    expect(state.configCalls).toBeGreaterThan(3);
    // Recovery via probeConnection completed init - the bad provider was caught,
    // not accepted.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // Parity with provider-add: init must run validateConfig() as an acceptance
  // gate (config-shape check) inside the SAME recovery loop, BEFORE the probe.
  // A config that fails validation must surface the recovery prompt - even
  // though probeConnection() would succeed - so a malformed provider is never
  // silently accepted. Here validateConfig fails on the first attempt and
  // passes after RE-ENTER, while probeConnection always succeeds: the recovery
  // prompt must be driven by the VALIDATION error, then init completes.
  it('should gate provider acceptance on validateConfig before probing, with the same recovery loop', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, validateAttempts: ['invalid', 'ok'], setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    // The validation failure (NOT a probe failure) surfaced the recovery prompt.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // validateConfig was actually exercised as a gate.
    expect(state.validateCalls).toBeGreaterThanOrEqual(1);
    // RE-ENTER re-ran configureInteractive for the provider whose config failed
    // validation (3 base configs + at least one re-entry).
    expect(state.configCalls).toBeGreaterThan(3);
    // init completed once validation passed after re-entry.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // The adapter's own questions can fail too: an FTPS or SSH server that does
  // not answer while configureInteractive reads its identity, or the adapter's
  // limit on going back to the connection prompts. Ending the whole init there
  // would cost the backup name, the scheme and every storage already set up, so
  // the error gets the same three choices as a failed probe.
  it('should offer the recovery choice when the configuration questions themselves fail, and finish after re-entry', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['fail', 'ok'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(chooseCalls.length).toBe(1);
    // The failure is reported on the CLI's own warning channel, as a failed probe is.
    expect(capture.errors.some((w) => w.includes('ECONNREFUSED'))).toBe(true);
    expect(state.configCalls).toBe(4); // the failed round, its re-entry, two more storages
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // The questions asked again after RE-ENTER can fail just the same - e.g. the
  // operator re-enters a host that does not answer. That second failure gets the
  // menu too, instead of ending the session.
  it('should offer the recovery choice when the re-entered configuration questions fail', async () => {
    const state: ProbeState = { attempts: ['fail'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['ok', 'fail', 'ok'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // RE-ENTER every time
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(chooseCalls.length).toBe(2); // the failed probe, then the failed re-entry
    expect(state.configCalls).toBe(5); // three rounds for the first storage, one each for two more
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // Ctrl+C inside the adapter's questions is the operator leaving, not a failure
  // to recover from - the menu must not catch it.
  it('should pass a Ctrl+C inside the configuration questions through, without the recovery choice', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['cancel'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(2);
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(result).toBe('cancelled');
    expect(chooseCalls.length).toBe(0);
    expect(mockInit).not.toHaveBeenCalled();
  });

  // Refusing the server identity is a decision ("Cancel (end the command)" in the
  // trust menu), not a failure: it ends the command with its own message and
  // never reaches the retry / re-enter / abort menu.
  it('should end the command without the recovery choice when the operator refuses the server identity', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['decline'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1);
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(result).toBe('abort');
    expect(chooseCalls.length).toBe(0);
    expect(capture.errors.join('\n')).toContain('was not trusted');
    expect(state.configCalls).toBe(1);
    expect(mockInit).not.toHaveBeenCalled();
  });

  // An adapter from another package throws its own copy of the class (and may
  // subclass it); the refusal must still end the command.
  it('should end the command when an adapter from another package signals the refusal with its own copy of the class', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['decline-foreign'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1);
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(result).toBe('abort');
    expect(chooseCalls.length).toBe(0);
    expect(capture.errors.join('\n')).toContain('was not trusted');
  });

  it('should end cleanly when the operator aborts after the configuration questions failed', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], configureAttempts: ['fail'] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(2); // pick ABORT (index 2)
    scriptInteractivePrompts();

    const result = await runInRoot(['init', 'myvault']);

    expect(chooseCalls.length).toBe(1);
    expect(result).toBe('abort');
    expect(mockInit).not.toHaveBeenCalled();
  });
});
