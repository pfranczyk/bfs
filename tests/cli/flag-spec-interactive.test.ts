import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// Two commands build a storage config out of flags rather than prompts: `bfs
// init <name> --provider "<spec>"` and `bfs repair <name> "<spec>"`. Both hand
// the adapter a ProviderIO while parsing, and both compute its `interactive`
// field as `!isCi` - which is `true` whenever the CI flag is absent, including
// a run whose stdin is a pipe. The contract at ProviderIO.interactive
// (src/types/index.ts) says the opposite: false under --ci, under --bootstrap,
// OR with no terminal attached.
//
// The field is not decoration here. FtpProvider.configureFromFlags refuses a
// secure storage that carries no basis for trusting it (no pinned fingerprint,
// no --accept-new-cert) precisely when `interactive === false` - a refusal that
// costs no socket. Claiming a terminal that isn't there disarms that guard, so
// a scripted run walks past the contradiction and only discovers it later, at
// the connection, or hangs on a question nobody can answer.
//
// Why the assertions pin the refusal instead of the field's value: an adapter
// reads the field to decide, so the decision is the observable behaviour and
// survives a rewrite of how the CLI computes it. The phrase asserted on is
// unique to ftp_cert_trust_conflict - ftp_cert_untrusted, raised later at the
// handshake, also names --accept-new-cert, so matching that flag alone would
// not tell the two apart.
//
// Each case is paired with the same command on a simulated terminal, where the
// refusal must NOT fire and the run must get further: that is the flow which
// legitimately reaches the operator, and a fix that forces non-interactivity
// everywhere would break it. The paired case asserts what the run went on to
// do, not merely that it failed differently - a bare "no refusal" would pass
// for a command broken into failing at once.
//
// The second block covers the sibling commands whose IO is built before any
// prompt, so the value is observable there too. `provider add` is absent on
// purpose: it builds its IO only after asking for a name and a type, so off a
// TTY the run ends at those prompts and never reaches the value under test.

const hoisted = vi.hoisted(() => ({ promptReached: false, captured: [] as (boolean | undefined)[], realFactory: null as Nullable<(workDir: string, interactive?: boolean) => import('../../src/types/index.js').ProviderIO> }));

// A prompt reached at all is the failure this is about: on a pipe there is
// nobody to answer it. Aborting here keeps the run deterministic instead of
// letting Inquirer wait on a stdin that never delivers.
vi.mock('../../src/cli/prompt.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cli/prompt.js')>();
  const { CommandAbort } = await import('../../src/cli/ui.js');
  return {
    ...actual,
    promptWithRawMode: async () => {
      hoisted.promptReached = true;
      throw new CommandAbort();
    },
  };
});

vi.mock('../../src/vault/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/config.js')>();
  return { ...actual, readConfig: vi.fn() };
});

// Passes through to the real factory - so `interactive` resolves exactly as in
// production - and records what each command asked for.
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  hoisted.realFactory = actual.createCliProviderIO;
  return {
    ...actual,
    createCliProviderIO: (workDir: string, interactive?: boolean) => {
      const factory = hoisted.realFactory;
      if (factory === null) throw new Error('real createCliProviderIO not captured');
      const io = factory(workDir, interactive);
      hoisted.captured.push(io.interactive);
      return io;
    },
  };
});

import { readConfig } from '../../src/vault/config.js';

// An FTPS storage (secure is the adapter's default) with neither a pinned
// fingerprint nor --accept-new-cert: the two instructions cannot both hold.
const FTP_SPEC = 'ftp:nas --host 127.0.0.1 --user u --password p --path /backup';
const CONFLICT = 'Conflicting instructions';

// process.stdin.isTTY is typed `boolean` but is `undefined` off a TTY at
// runtime; this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('storage specs parsed from flags - IO interactivity', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;
  let root: string;

  beforeEach(async () => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    hoisted.promptReached = false;
    hoisted.captured = [];
    // A real (small) working directory: `init` scans it before its first
    // prompt, so the run must have something to scan.
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-flag-spec-'));
    await fs.writeFile(path.join(root, 'data.txt'), 'hello backup world', 'utf8');
    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
  });

  afterEach(async () => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('should refuse an untrustable secure storage when init parses a spec off a TTY', async () => {
    stdinTty.isTTY = undefined;

    await runCmd(['init', 'kopia', '--provider', FTP_SPEC, '--cwd', root]);

    expect(capture.errors.join('\n')).toContain(CONFLICT);
    // The refusal has to land while the spec is parsed - before the run starts
    // asking about anything else. Reaching a prompt means it walked past.
    expect(hoisted.promptReached).toBe(false);
  });

  it('should keep asking about the certificate when init parses a spec on a TTY', async () => {
    // A/B control: on a terminal the operator can be asked, so the refusal must
    // stay away. Green before and after the fix - it rejects a repair that
    // silences the interactive flow along with the scripted one.
    stdinTty.isTTY = true;

    await runCmd(['init', 'kopia', '--provider', FTP_SPEC, '--cwd', root]);

    expect(capture.errors.join('\n')).not.toContain(CONFLICT);
    expect(hoisted.promptReached).toBe(true);
  });

  it('should refuse the same storage under init --ci', async () => {
    // The branch that already states non-interactivity outright, kept here as
    // the reference behaviour the two cases above are measured against.
    stdinTty.isTTY = true;

    await runCmd(['init', 'kopia', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', FTP_SPEC, '--cwd', root]);

    expect(capture.errors.join('\n')).toContain(CONFLICT);
  });

  it('should refuse an untrustable secure storage when repair parses a migration off a TTY', async () => {
    stdinTty.isTTY = undefined;

    await runCmd(['repair', 'dysk-1', FTP_SPEC, '--cwd', root]);

    const errors = capture.errors.join('\n');
    expect(errors).toContain(CONFLICT);
    // The refusal belongs to parsing the spec, which happens before the run
    // resolves which versions to work on. Without this, moving version
    // resolution earlier would turn the case red again with a message that
    // says nothing about the cause.
    expect(errors).not.toContain('No matching versions');
    expect(hoisted.captured[0]).toBe(false);
  });

  it('should carry on past the spec when repair parses a migration on a TTY', async () => {
    // A/B control with a positive half: the run must not merely skip the
    // refusal, it must get through parsing to the next step. A command broken
    // into failing immediately would satisfy the negative half alone.
    stdinTty.isTTY = true;

    await runCmd(['repair', 'dysk-1', FTP_SPEC, '--cwd', root]);

    const errors = capture.errors.join('\n');
    expect(errors).not.toContain(CONFLICT);
    expect(errors).toContain('No matching versions');
  });
});

// The IO these two build is reachable before they ask anything, so the value is
// observable without simulating answers. No built-in acts on it here - both
// stop at their first prompt - which is why these pin the value itself rather
// than a refusal: the guarantee is what an external adapter is handed.
describe('sibling commands - IO interactivity before the first prompt', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    hoisted.promptReached = false;
    hoisted.captured = [];
    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
  });

  it('should build a non-interactive IO for recovery off a TTY', async () => {
    stdinTty.isTTY = undefined;

    await runCmd(['recovery']);

    expect(hoisted.captured[0]).toBe(false);
  });

  it('should keep recovery interactive on a TTY', async () => {
    stdinTty.isTTY = true;

    await runCmd(['recovery']);

    expect(hoisted.captured[0]).toBe(true);
  });

  it('should build a non-interactive IO for provider remove off a TTY', async () => {
    stdinTty.isTTY = undefined;

    await runCmd(['provider', 'remove']);

    expect(hoisted.captured[0]).toBe(false);
  });

  it('should keep provider remove interactive on a TTY', async () => {
    stdinTty.isTTY = true;

    await runCmd(['provider', 'remove']);

    expect(hoisted.captured[0]).toBe(true);
  });
});
