import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// What these three cases pin: `bfs provider edit` builds its ProviderIO so that
// `interactive` follows the whole contract at ProviderIO.interactive
// (src/types/index.ts) - false under --ci, under --bootstrap, OR with no
// terminal attached - and not just the part the flag states. An adapter is
// entitled to read that field and pick a safe default instead of prompting;
// handing it `true` under --ci invites a question nobody is there to answer.
//
// No built-in reads the field on this path (the --ci branch only runs
// configureFromFlags + validateConfig, and SSH's host-key capture gate is shut
// earlier by input.offline), so the case that matters is an external adapter.
//
// This lives as a CLI unit test because it is the only layer where the value is
// observable. Neither harness that drives a real `bfs` attaches a terminal -
// smoke spawns with stdin as a pipe, cli-e2e redirects it from /dev/null - so
// both yield false whatever the CLI computes. The PTY branch of cli-e2e does
// give a real TTY, but no built-in changes behaviour here, so there would be
// nothing to assert against.
//
// The two cases without --ci are an A/B control, green whichever way the flag is
// wired, and they are here to reject one specific shape: `!isCi` (what the
// sibling commands pass) satisfies the flag but claims interactivity for an edit
// whose stdin is a pipe, which is the opposite error.

const hoisted = vi.hoisted(() => ({ captured: null as Nullable<ProviderIO>, real: null as Nullable<(workDir: string, interactive?: boolean) => ProviderIO>, adapterSaw: null as Nullable<boolean | undefined> }));

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  hoisted.real = actual.createCliProviderIO;
  return {
    ...actual,
    // Pass through to the real factory (so `interactive` resolves exactly as in
    // production) and capture the IO the command actually builds.
    createCliProviderIO: (workDir: string, interactive?: boolean): ProviderIO => {
      const factory = hoisted.real;
      if (factory === null) throw new Error('real createCliProviderIO not captured');
      const io = factory(workDir, interactive);
      hoisted.captured = io;
      return io;
    },
  };
});

import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { providerRegistry } from '../../src/providers/provider.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';

// A stand-in for an external adapter: it records the `interactive` value it was
// handed. Local disk semantics come from LocalFsProvider so the --ci flag path
// (configureFromFlags + validateConfig) completes for real.
const PROBE_TYPE = 'local-interactive-probe';

class ProbeProvider extends LocalFsProvider {
  constructor(config: ProviderConfig, io: ProviderIO) {
    super(config, io);
    hoisted.adapterSaw = io.interactive;
  }
}

// process.stdin.isTTY is `boolean` in the Node types but `undefined` at runtime
// off a TTY; this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('provider edit - IO interactivity', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    capture = captureConsole();
    hoisted.captured = null;
    hoisted.adapterSaw = null;
    providerRegistry.register(PROBE_TYPE, {
      lang: 'en',
      displayName: 'Local probe (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new ProbeProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [{ id: 'dysk-1', type: PROBE_TYPE, config: { path: '/tmp/d1' } }] }) as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    prevTTY = stdinTty.isTTY;
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(PROBE_TYPE);
    vi.clearAllMocks();
  });

  it('should hand the adapter a non-interactive IO under --ci, even on a TTY', async () => {
    stdinTty.isTTY = true;

    const outcome = await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--path', '/tmp/edited']);

    // Positive gate: the edit really ran, so the assertion below is about the
    // value the adapter got - not about a command that bailed out early.
    expect(outcome).toBe('ok');
    expect(vi.mocked(writeConfig)).toHaveBeenCalledOnce();
    expect(hoisted.adapterSaw).toBe(false);
    expect(hoisted.captured?.interactive).toBe(false);
  });

  it('should keep the IO non-interactive without --ci when stdin is not a TTY', async () => {
    // A/B control against `!isCi`: that shape would force true here, where the
    // contract ("false under --ci OR a missing TTY") demands false.
    // The edit stops at the unknown id, which is after the IO is built and
    // before any prompt - nothing here depends on an adapter answering.
    stdinTty.isTTY = undefined;

    const outcome = await runCmd(['provider', 'edit', 'nie-ma-takiego']);

    expect(outcome).toBe('abort');
    expect(hoisted.captured?.interactive).toBe(false);
  });

  it('should keep the IO interactive without --ci on a TTY', async () => {
    // The other side of the A/B control: the repair must not silence prompts on
    // a normal terminal, which is where the interactive edit does its work.
    stdinTty.isTTY = true;

    const outcome = await runCmd(['provider', 'edit', 'nie-ma-takiego']);

    expect(outcome).toBe('abort');
    expect(hoisted.captured?.interactive).toBe(true);
  });
});
