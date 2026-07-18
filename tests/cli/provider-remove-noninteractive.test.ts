import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderIO } from '../../src/types/index.js';
import { makeConfig, runCmd } from './_helpers.js';

// Regression: `provider remove` must build a NON-interactive ProviderIO in
// --strategy (batch/CI) mode, exactly as repair (createCliProviderIO(rootDir,
// opts.ci !== true)) and recovery (createCliProviderIO(rootDir, !isCi)) already
// do. Today it calls createCliProviderIO(rootDir) with no flag, so `interactive`
// defaults to process.stdin.isTTY. On a real TTY that yields interactive=true,
// which drives an SSH target's host-key decision (decideHostKeyTrust in
// src/providers/ssh.ts) into an io.confirm() prompt — silently ignoring
// --accept-new-host-key during a flag-driven batch remove.
//
// Non-TTY harnesses (smoke, cli-e2e; both run with stdin from /dev/null) MASK
// this: isTTY is already false there, so the buggy path yields interactive=false
// and "works" by accident. The bug is only observable by simulating a TTY, which
// is why this lives as a CLI unit test and not in smoke.

const hoisted = vi.hoisted(() => ({ captured: null as ProviderIO | null, real: null as ((workDir: string, interactive?: boolean) => ProviderIO) | null }));

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

describe('provider remove — IO interactivity in --strategy mode', () => {
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    hoisted.captured = null;
    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(removeProvider).mockResolvedValue(undefined as never);

    // Simulate an interactive terminal — the exact condition under which the bug
    // surfaces. Without this, isTTY is false and the buggy path is indistinguishable.
    prevTTY = stdinTty.isTTY;
    stdinTty.isTTY = true;
  });

  afterEach(() => {
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
  });

  it('should build a non-interactive IO when a --strategy is given, even on a TTY', async () => {
    await runCmd(['provider', 'remove', 'dysk-3', '--strategy', 'remove', '--yes']);

    expect(hoisted.captured).not.toBeNull();
    expect(hoisted.captured?.interactive).toBe(false);
  });
});
