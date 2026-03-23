/**
 * REPL behaviour tests.
 *
 * Strategy: mock readline.createInterface to return a controlled fake RL,
 * inject responses one by one, assert on close / error handling / output.
 */

import readline from 'node:readline';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRepl } from '../../src/cli/repl.js';
import { CommandAbort } from '../../src/cli/ui.js';

vi.mock('../../src/vault/config.js', () => ({
  readConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../src/vault/state.js', () => ({
  readState: vi
    .fn()
    .mockResolvedValue({ latest_version: 0, working_version: 0 }),
}));

// ─── Fake readline factory ─────────────────────────────────────────────────

type QuestionCb = (input: string) => void;

function createFakeRl(lines: string[]) {
  let closeCallback: (() => void) | null = null;
  let idx = 0;
  const instance = {
    closed: false,
    question: vi.fn((_prompt: string, cb: QuestionCb) => {
      if (instance.closed) return;
      if (idx < lines.length) {
        const line = lines[idx++];
        // Simulate async: fire callback after current tick
        setImmediate(() => {
          if (!instance.closed) cb(line);
        });
      }
    }),
    close: vi.fn(() => {
      instance.closed = true;
      closeCallback?.();
    }),
    pause: vi.fn(),
    resume: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeCallback = handler;
      return instance;
    }),
  };
  return instance;
}

type FakeRl = ReturnType<typeof createFakeRl>;

function withFakeRl(lines: string[]): {
  rl: FakeRl;
  logs: string[];
  errors: string[];
} {
  const rl = createFakeRl(lines);
  vi.spyOn(readline, 'createInterface').mockReturnValueOnce(rl as never);

  const stripAnsi = (s: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
    s.replace(/\x1B\[[0-9;]*m/g, '');

  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a) =>
    logs.push(stripAnsi(a.map(String).join(' '))),
  );
  vi.spyOn(console, 'error').mockImplementation((...a) =>
    errors.push(stripAnsi(a.map(String).join(' '))),
  );

  return { rl, logs, errors };
}

describe('REPL', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Wyjście ──────────────────────────────────────────────────────────────

  it('should close readline when user types "exit"', async () => {
    const { rl } = withFakeRl(['exit']);
    await startRepl('/fake', async () => {});
    expect(rl.close).toHaveBeenCalled();
  });

  it('should close readline when user types "quit"', async () => {
    const { rl } = withFakeRl(['quit']);
    await startRepl('/fake', async () => {});
    expect(rl.close).toHaveBeenCalled();
  });

  it('should print "Do widzenia" on exit', async () => {
    const { logs } = withFakeRl(['exit']);
    await startRepl('/fake', async () => {});
    expect(logs.some((l) => l.includes('Goodbye'))).toBe(true);
  });

  // ─── Puste linie ──────────────────────────────────────────────────────────

  it('should ignore empty lines and not call runCommand', async () => {
    const called: string[][] = [];
    const { rl } = withFakeRl(['', '  ', 'exit']);
    await startRepl('/fake', async (tokens) => {
      called.push(tokens);
    });
    expect(called).toHaveLength(0);
    expect(rl.close).toHaveBeenCalled();
  });

  // ─── Help ─────────────────────────────────────────────────────────────────

  it('should print help listing push, pull, provider commands', async () => {
    const { logs } = withFakeRl(['help', 'exit']);
    await startRepl('/fake', async () => {});
    const all = logs.join('\n');
    expect(all).toContain('push');
    expect(all).toContain('pull');
    expect(all).toContain('provider remove');
  });

  // ─── CommandAbort — zostaje w REPL ───────────────────────────────────────

  it('should stay in REPL after CommandAbort', async () => {
    let calls = 0;
    const { rl } = withFakeRl(['cmd', 'exit']);
    await startRepl('/fake', async () => {
      calls++;
      throw new CommandAbort();
    });
    expect(calls).toBe(1);
    expect(rl.close).toHaveBeenCalled(); // reached 'exit'
  });

  it('should NOT print error message after CommandAbort', async () => {
    const { errors } = withFakeRl(['cmd', 'exit']);
    await startRepl('/fake', async () => {
      throw new CommandAbort();
    });
    // CommandAbort has empty message, no "Błąd:" should appear
    expect(errors.some((l) => l.includes('Błąd:'))).toBe(false);
  });

  // ─── Generic Error — zostaje w REPL ──────────────────────────────────────

  it('should stay in REPL after generic Error', async () => {
    let calls = 0;
    const { rl } = withFakeRl(['bad', 'exit']);
    await startRepl('/fake', async () => {
      calls++;
      throw new Error('oops');
    });
    expect(calls).toBe(1);
    expect(rl.close).toHaveBeenCalled();
  });

  it('should print error message after generic Error', async () => {
    const { errors } = withFakeRl(['bad', 'exit']);
    await startRepl('/fake', async () => {
      throw new Error('test-error-message');
    });
    expect(errors.some((l) => l.includes('test-error-message'))).toBe(true);
  });

  // ─── CommanderError (help) — zostaje w REPL ───────────────────────────────

  it('should stay in REPL after CommanderError for help', async () => {
    const helpErr = Object.assign(new Error('(outputHelp)'), {
      code: 'commander.help',
    });
    let calls = 0;
    const { rl } = withFakeRl(['provider', 'exit']);
    await startRepl('/fake', async () => {
      calls++;
      throw helpErr;
    });
    expect(calls).toBe(1);
    expect(rl.close).toHaveBeenCalled();
  });

  it('should NOT print "(outputHelp)" error after CommanderError', async () => {
    const helpErr = Object.assign(new Error('(outputHelp)'), {
      code: 'commander.help',
    });
    const { errors, logs } = withFakeRl(['provider', 'exit']);
    await startRepl('/fake', async () => {
      throw helpErr;
    });
    const all = [...logs, ...errors].join('\n');
    expect(all).not.toContain('outputHelp');
  });

  // ─── Kolejność komend ─────────────────────────────────────────────────────

  it('should dispatch commands in sequence', async () => {
    const received: string[][] = [];
    withFakeRl(['cmd1 --opt a', 'cmd2 arg', 'exit']);
    await startRepl('/fake', async (tokens) => {
      received.push(tokens);
    });
    expect(received).toEqual([
      ['cmd1', '--opt', 'a'],
      ['cmd2', 'arg'],
    ]);
  });

  it('should split quoted arguments correctly', async () => {
    const received: string[][] = [];
    withFakeRl(['push --password "my secret"', 'exit']);
    await startRepl('/fake', async (tokens) => {
      received.push(tokens);
    });
    expect(received[0]).toEqual(['push', '--password', 'my secret']);
  });

  it('should process command after recovering from error', async () => {
    const received: string[][] = [];
    withFakeRl(['bad', 'good arg', 'exit']);
    await startRepl('/fake', async (tokens) => {
      if (tokens[0] === 'bad') throw new Error('boom');
      received.push(tokens);
    });
    expect(received).toEqual([['good', 'arg']]);
  });

  // ─── Zarządzanie stdin dla Inquirer ───────────────────────────────────────

  it('should pause readline before dispatching command so Inquirer gets exclusive stdin access', async () => {
    // Bug: when readline (REPL) is actively listening to stdin while Inquirer
    // also tries to use stdin, they compete — Inquirer prompt never renders.
    // Fix: rl.pause() must be called before runCommand so readline releases stdin.
    const { rl } = withFakeRl(['cmd', 'exit']);
    let rlWasPausedWhenCommandRan = false;

    await startRepl('/fake', async () => {
      rlWasPausedWhenCommandRan =
        (rl.pause as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    });

    expect(rlWasPausedWhenCommandRan).toBe(true);
  });

  it('should resume readline after each command so subsequent Inquirer prompts work', async () => {
    // After the command completes (and Inquirer may have paused stdin),
    // the REPL must resume both process.stdin and rl so the next command
    // can again use Inquirer without hanging.
    const { rl } = withFakeRl(['cmd', 'exit']);
    const order: string[] = [];

    (rl.pause as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('pause');
    });
    (rl.resume as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('resume');
    });

    await startRepl('/fake', async () => {
      order.push('command');
    });

    // pause → command → resume (in this order)
    const cmdIdx = order.indexOf('command');
    const lastPauseBeforeCmd = order.lastIndexOf('pause', cmdIdx - 1);
    const firstResumeAfterCmd = order.indexOf('resume', cmdIdx + 1);

    expect(lastPauseBeforeCmd).toBeGreaterThanOrEqual(0); // pause happened before command
    expect(firstResumeAfterCmd).toBeGreaterThan(cmdIdx); // resume happened after command
  });
});
