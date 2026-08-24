import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderIO } from '../../src/types/index.js';
import { makeConfig, runCmd } from './_helpers.js';

// `--strategy` supplies the decision the command would otherwise ask for; it does
// not declare that nobody is watching. So at a terminal the run stays
// interactive - an operator who names the strategy but leaves out the password of
// an encrypted backup is still asked for it, and a server identity BFS has not
// seen is still put to them. Only `--ci` forbids the question, and then an
// incomplete command fails instead of asking.
//
// A simulated TTY is the only setting where the two answers differ: both
// harnesses that drive a real `bfs` (smoke, cli-e2e) run with stdin off a
// terminal, so there the value comes out false whatever the command passes.
// That is why this is a CLI unit test rather than a smoke assertion.

const hoisted = vi.hoisted(() => ({ captured: null as Nullable<ProviderIO>, real: null as Nullable<(workDir: string, interactive?: boolean) => ProviderIO> }));

vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn(), removeProvider: vi.fn() }));
vi.mock('../../src/providers/provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/provider.js')>();
  hoisted.real = actual.createCliProviderIO;
  return {
    ...actual,
    // Pass through to the real factory (so `interactive` is resolved exactly as
    // in production) and capture the IO the command actually builds.
    createCliProviderIO: (workDir: string, interactive?: boolean): ProviderIO => {
      const factory = hoisted.real;
      if (factory === null) throw new Error('real createCliProviderIO not captured');
      const io = factory(workDir, interactive);
      hoisted.captured = io;
      return io;
    },
  };
});

import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listVersions, removeProvider } from '../../src/vault/vault-manager.js';

// process.stdin.isTTY is `boolean` in the Node types but `undefined` at runtime
// off a TTY; this accessor lets us save/restore the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('provider remove - what decides whether it may ask', () => {
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    hoisted.captured = null;
    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(removeProvider).mockResolvedValue(undefined as never);

    // Simulate an interactive terminal - the exact condition under which the bug
    // surfaces. Without this, isTTY is false and the buggy path is indistinguishable.
    prevTTY = stdinTty.isTTY;
    stdinTty.isTTY = true;
  });

  afterEach(() => {
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
  });

  it('should stay interactive on a TTY when only a --strategy is given', async () => {
    await runCmd(['provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes']);

    expect(hoisted.captured).not.toBeNull();
    expect(hoisted.captured?.interactive).toBe(true);
  });

  it('should build a non-interactive IO when the run declares --ci', async () => {
    await runCmd(['--ci', 'provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes']);

    expect(hoisted.captured).not.toBeNull();
    expect(hoisted.captured?.interactive).toBe(false);
  });

  // `--ci` declares the mode of the whole run, so BFS collects it from the
  // command line wherever the operator typed it. A command that forwards its
  // unknown tokens to the adapter must not be the one that eats it: the operator
  // sees the flag accepted and gets the opposite mode, and the adapter receives a
  // token that was never addressed to it.
  it('should declare the mode when --ci follows the sub-command', async () => {
    await runCmd(['provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes', '--ci']);

    expect(hoisted.captured).not.toBeNull();
    expect(hoisted.captured?.interactive).toBe(false);
  });

  it('should declare the mode when --ci sits among the adapter flags', async () => {
    await runCmd(['provider', 'remove', 'dysk-3', '--ci', '--strategy', 'remove', '--yes']);

    expect(hoisted.captured).not.toBeNull();
    expect(hoisted.captured?.interactive).toBe(false);
  });
});
