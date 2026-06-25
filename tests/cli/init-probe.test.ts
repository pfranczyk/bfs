// Interactive `bfs init` — provider connectivity probe + retry.
//
// Right after a provider's configureInteractive() returns, the init action
// instantiates the provider and validates the medium with a full storage
// round-trip via probeConnection() inside a retry loop. authenticate() alone is
// too weak a gate: a provider can authenticate (e.g. FTP with a valid
// host/port/login) yet have an unusable base path. probeConnection() exercises
// the medium end to end, so it is the acceptance gate for the chosen medium. On
// a ProviderError it warns via io.warn and asks io.choose with three options in
// a fixed order:
//   [0] RETRY    — re-probe the same config
//   [1] RE-ENTER — re-run configureInteractive for that provider
//   [2] ABORT    — clean cancellation, no stack dump
// RETRY→success or RE-ENTER→success completes init; ABORT ends cleanly. This
// keeps a connection failure — transient, or a typo in host/port/password/path
// — recoverable in place, instead of aborting the whole command and discarding
// every value the operator already entered.
//
// The recovery option is selected by INDEX in the offered list (documented
// order RETRY/RE-ENTER/ABORT), so these tests stay independent of the prompt's
// i18n wording (keys probe_connection, probe_failed_prompt,
// probe_choice_retry / _reenter / _abort in src/i18n/en.ts + pl.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import * as providerMod from '../../src/providers/provider.js';
import { providerRegistry } from '../../src/providers/provider.js';
import type { ProviderIO, StorageProvider } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { captureConsole, runCmd } from './_helpers.js';

vi.mock('../../src/vault/vault-manager.js', () => ({ init: vi.fn() }));
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
// scanDir / compressibility analysis hit fs — return an empty directory so the
// test stays off disk (mirrors tests/cli/init.test.ts).
vi.mock('node:fs/promises', () => {
  const mock = { readdir: vi.fn().mockResolvedValue([]), stat: vi.fn().mockResolvedValue({ isDirectory: () => true, size: 0 }), access: vi.fn().mockResolvedValue(undefined), constants: { R_OK: 4, W_OK: 2, X_OK: 1, F_OK: 0 } };
  return { default: mock, ...mock };
});

import inquirer from 'inquirer';
import { init } from '../../src/vault/vault-manager.js';

const mockInit = vi.mocked(init);
const mockPrompt = vi.mocked(inquirer.prompt);

const PROBE_TYPE = 'mockprobe';

interface ProbeState {
  /** One outcome consumed per probeConnection() call: 'fail' throws, 'ok' resolves. */
  attempts: string[];
  /**
   * Count of probeConnection() invocations — the acceptance gate. One scripted
   * outcome from `attempts` is consumed per call.
   */
  probeCalls: number;
  /**
   * Count of authenticate() invocations. Kept separate (and never the gate) to
   * prove authenticate() alone does NOT decide provider acceptance — it is a
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
   * runs validateConfig() as a gate (parity with provider-add) — a config that
   * fails validation must surface the recovery prompt BEFORE probing, not be
   * silently accepted. Defaults to always-valid when undefined.
   */
  validateAttempts?: string[];
  /** Count of validateConfig() invocations — never the probe gate. */
  validateCalls: number;
}

/**
 * Registers a mock provider type on the global singleton registry. Its
 * probeConnection() follows the scripted `attempts` (extra calls past the array
 * succeed) and is the acceptance gate; authenticate() is a no-op that never
 * gates. configureInteractive() needs no inquirer prompt (it just returns a
 * config), so the per-provider prompt budget is only id + type.
 */
function registerProbeProvider(state: ProbeState): void {
  providerRegistry.register(PROBE_TYPE, {
    lang: 'en',
    displayName: 'Mock Probe',
    create: () =>
      ({
        // Lightweight connect/login — NOT the acceptance gate. Never throws.
        async authenticate(): Promise<void> {
          state.authCalls += 1;
          return;
        },
        // Full storage round-trip — THIS is the acceptance gate. One scripted
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
          state.configCalls += 1;
          return { marker: state.configCalls };
        },
        // Config-shape gate run BEFORE the round-trip probe. One scripted
        // outcome consumed per call; 'invalid' returns a non-empty error list.
        // Never gates the probe — a separate acceptance step.
        validateConfig(): string[] {
          const outcome = state.validateAttempts?.[state.validateCalls] ?? 'ok';
          state.validateCalls += 1;
          return outcome === 'invalid' ? ['mock validation error'] : [];
        },
        // Provider-API completeness surface (v2) — unused by the probe path.
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
 * returns the option at `pickIndex` — picking the recovery action by its
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
 * providers. The prompt order is: encryption, compression, scheme, then per
 * provider (id, type), then push mode, RAM. Encryption + compression are
 * answered "no" via inquirer (NOT via flags — the action detects --no-compress
 * from process.argv, which is not set under vitest, so it always prompts).
 */
function scriptInteractivePrompts(): void {
  mockPrompt
    .mockResolvedValueOnce({ encEnabled: false } as never) // encryption
    .mockResolvedValueOnce({ compressEnabled: false } as never) // compression
    .mockResolvedValueOnce({ dataShardsStr: '2', parityShardsStr: '1' } as never) // scheme
    .mockResolvedValueOnce({ id: 'p1' } as never) // provider 1 id
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never) // provider 1 type
    .mockResolvedValueOnce({ id: 'p2' } as never)
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never)
    .mockResolvedValueOnce({ id: 'p3' } as never)
    .mockResolvedValueOnce({ type: PROBE_TYPE } as never)
    .mockResolvedValueOnce({ pushMode: PushMode.NewVersion } as never) // push mode
    .mockResolvedValueOnce({ maxRamStr: '1024' } as never); // RAM
}

describe('interactive init — provider connectivity probe + retry', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockInit.mockResolvedValue(undefined);
  });

  afterEach(() => {
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
  });

  it('RETRY: should re-probe the same config and complete init after a transient failure', async () => {
    // First provider's probe round-trip fails once, then succeeds on retry; the
    // other two succeed on their first probe.
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(0); // pick RETRY (index 0)
    scriptInteractivePrompts();

    const result = await runCmd(['init', 'myvault']);

    // The recovery choice prompt must actually have been presented.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // Probe re-ran the SAME config: the failing provider was probed twice
    // (fail → ok), and configureInteractive ran exactly once per provider
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

    const result = await runCmd(['init', 'myvault']);

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

    const result = await runCmd(['init', 'myvault']);

    // The recovery prompt was shown and the operator chose abort.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // Clean cancellation: runCmd maps CommandAbort → 'abort' and prompt
    // cancellation → 'cancelled'. Either is an intentional, handled outcome —
    // what must NOT happen is an unexpected uncaught error type (runCmd rethrows
    // those) or silently reaching vault-manager.init() despite the abort.
    expect(['abort', 'cancelled']).toContain(result);
    expect(mockInit).not.toHaveBeenCalled();
  });

  // Message-agnosticism: the recovery loop must fire for ANY ProviderError,
  // regardless of the failure text. This guards against a fix special-cased to
  // one symptom (e.g. "530 max connections") — every real FTP wrong-field
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

  it.each(FAILURE_MESSAGES)('RE-ENTER recovery fires for any ProviderError — $field', async ({ message }) => {
    // First probe of the first provider fails with the field-specific message;
    // after RE-ENTER its next probe succeeds. The other two succeed immediately.
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [], failMessage: message };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runCmd(['init', 'myvault']);

    // The recovery choice prompt was presented regardless of the failure text.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // RE-ENTER re-ran configureInteractive for the failing provider.
    expect(state.configCalls).toBeGreaterThan(3);
    // init completed after recovery.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // Regression: init MUST gate provider acceptance on probeConnection() — the full
  // storage round-trip — not on authenticate(). A provider that authenticates
  // (valid host/port/login) but has an unusable base path fails the round-trip;
  // it must NOT be silently accepted. Here the first provider's first probe
  // fails and the second (after RE-ENTER) succeeds — recovery is driven entirely
  // by the probeConnection() outcome. authCalls is deliberately NOT the gate:
  // whether authenticate() ran or not is irrelevant to acceptance.
  it('should gate provider acceptance on probeConnection round-trip, not authenticate', async () => {
    const state: ProbeState = { attempts: ['fail', 'ok'], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runCmd(['init', 'myvault']);

    // The probeConnection failure surfaced the recovery prompt.
    expect(chooseCalls.length).toBeGreaterThanOrEqual(1);
    // The round-trip gate ran across all providers plus the re-probe.
    expect(state.probeCalls).toBeGreaterThanOrEqual(4);
    // The gate wired the vault name before probing — a dropped setVaultName()
    // would leave probeConnection() unable to resolve its path on real providers.
    expect(state.setVaultNames).toContain('myvault');
    // RE-ENTER re-ran configureInteractive for the failing provider.
    expect(state.configCalls).toBeGreaterThan(3);
    // Recovery via probeConnection completed init — the bad provider was caught,
    // not accepted.
    expect(result).toBe('ok');
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  // Parity with provider-add: init must run validateConfig() as an acceptance
  // gate (config-shape check) inside the SAME recovery loop, BEFORE the probe.
  // A config that fails validation must surface the recovery prompt — even
  // though probeConnection() would succeed — so a malformed provider is never
  // silently accepted. Here validateConfig fails on the first attempt and
  // passes after RE-ENTER, while probeConnection always succeeds: the recovery
  // prompt must be driven by the VALIDATION error, then init completes.
  it('should gate provider acceptance on validateConfig before probing, with the same recovery loop', async () => {
    const state: ProbeState = { attempts: [], probeCalls: 0, authCalls: 0, configCalls: 0, validateCalls: 0, validateAttempts: ['invalid', 'ok'], setVaultNames: [] };
    registerProbeProvider(state);
    const { chooseCalls } = installProbeIO(1); // pick RE-ENTER (index 1)
    scriptInteractivePrompts();

    const result = await runCmd(['init', 'myvault']);

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
});
