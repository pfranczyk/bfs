import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, runCmd } from './_helpers.js';

// `bfs init` builds a ProviderIO in four places, and this pins one of them: the
// IO handed to init(), which the pre-write verification loop runs under when it
// probes every storage. That loop is where a storage server's identity gets
// settled, so under --ci it must carry "nobody is at the keyboard" - otherwise
// FTPS, which is the adapter's default, reaches the rung of its trust ladder
// that asks the operator instead of the one that refuses, inside a run that
// declared nobody is watching it.
//
// The other three are not this test's business: the two that parse --provider
// specs (one per branch) and the one behind the interactive per-storage
// prompts. What the non-CI spec branch hands an adapter is pinned separately,
// in flag-spec-interactive.test.ts.
//
// A mock IO is not runtime IO: the value is computed in the CLI layer, so
// injecting it into a mock would test nothing. This drives the real command with
// a simulated TTY - the only setting where the two possible answers differ - and
// reads the IO off the options init() was handed.
//
// Limit of this test, stated rather than papered over: it does not separate the
// correct wiring from a constant "nobody is there". Nothing available separates
// them, because no built-in reads the value on this path with an unsettled
// identity - configuring an FTPS or SSH storage interactively captures and pins
// the fingerprint up front, so the probe afterwards decides from the pin (see
// scenario 107-init-interactive-ftps-trust). The constant is rejected by the
// contract at ProviderIO.interactive, not by a red test.
//
// The runtime proof that a prompt is what actually happens today - and stops
// happening - lives in scenario 106-init-ci-ftps-no-trust, which drives a real
// terminal against a real FTPS server. Neither smoke nor plain cli-e2e can show
// it: one spawns with a pipe, the other redirects from /dev/null, so both come
// out non-interactive whatever the code does.

vi.mock('../../src/vault/vault-manager.js', () => ({ init: vi.fn() }));

import { init } from '../../src/vault/vault-manager.js';

// process.stdin.isTTY is typed `boolean` but is `undefined` off a TTY at runtime;
// this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('init --ci - IO interactivity handed to the verification loop', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;
  let root: string;

  beforeEach(async () => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    // A simulated terminal is the only setting that discriminates: off a TTY the
    // IO comes out non-interactive whatever the command passes.
    stdinTty.isTTY = true;

    // A real (small) working directory so the command's scan / compressibility
    // pass runs against actual files; init() itself is mocked and asserted on.
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-ci-tty-'));
    await fs.writeFile(path.join(root, 'data.txt'), 'hello backup world', 'utf8');

    vi.mocked(init).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('should hand init a non-interactive IO under --ci, even on a TTY', async () => {
    await runCmd([
      'init',
      'securevault',
      '--ci',
      '--data-shards',
      '2',
      '--parity-shards',
      '1',
      '--provider',
      'local:p1 --path /tmp/bfs-p1',
      '--provider',
      'local:p2 --path /tmp/bfs-p2',
      '--provider',
      'local:p3 --path /tmp/bfs-p3',
      '--cwd',
      root,
    ]);

    // Positive gate: the command really reached init() with its three storages,
    // so the assertion below is about the value that loop got - not about a
    // command that aborted on the way.
    expect(vi.mocked(init)).toHaveBeenCalledOnce();
    const options = vi.mocked(init).mock.calls[0][1];
    expect(options.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);

    // This is the IO probeConnection() runs under, so it decides whether a
    // storage whose identity is unknown is asked about or refused.
    expect(options.io.interactive).toBe(false);
  });
});
