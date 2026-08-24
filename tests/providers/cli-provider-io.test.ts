import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { createCliProviderIO } from '../../src/providers/provider.js';

// What the CLI's ProviderIO does when nobody can answer. A prompt issued there
// never settles: the event loop empties, the process ends where it stood, and
// the rejection arrives during shutdown - too late for any caller to write a
// file, print a message or set an exit code. So the question is not asked at
// all, and each kind of question is refused in the way that fits it.
//
// Simulating a terminal is the only way to tell the two answers apart: under
// Vitest stdin is never a TTY, so without the switch below every case would look
// non-interactive whatever the constructor was told.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('createCliProviderIO with nobody to answer', () => {
  let prevTty: boolean | undefined;

  beforeEach(() => {
    prevTty = stdinTty.isTTY;
    stdinTty.isTTY = false;
  });

  afterEach(() => {
    stdinTty.isTTY = prevTty;
    vi.restoreAllMocks();
  });

  it('should refuse a question asking for a value', async () => {
    const io = createCliProviderIO(process.cwd(), false);

    await expect(io.ask('Enter host:')).rejects.toThrow(BfsError);
  });

  it('should refuse a question asking for a secret', async () => {
    const io = createCliProviderIO(process.cwd(), false);

    await expect(io.askSecret('Enter password:')).rejects.toThrow(BfsError);
  });

  it('should quote the question it could not ask', async () => {
    const io = createCliProviderIO(process.cwd(), false);

    // Naming the question is what makes the refusal actionable: the operator
    // learns which value to put on the command line.
    await expect(io.askSecret('Enter decryption password:')).rejects.toThrow(/Enter decryption password:/);
  });

  it('should refuse a menu rather than invent a choice', async () => {
    // Unlike yes/no, a menu has no safe answer to pick: which entry means "give
    // up" is the caller's knowledge, not this layer's.
    const io = createCliProviderIO(process.cwd(), false);

    await expect(io.choose('Pick one:', ['retry', 'abort'])).rejects.toThrow(BfsError);
  });

  it('should answer a yes/no question with no', async () => {
    // This is the half that holds the gates: an unconfirmed location stays
    // unapproved, an overwrite does not happen. Answering "yes" here would
    // auto-approve recovered provider locations - the very thing the gate exists
    // to prevent - and nothing else in the suite would notice.
    const io = createCliProviderIO(process.cwd(), false);

    await expect(io.confirm('Send backup data to these locations?')).resolves.toBe(false);
  });

  it('should keep asking when a terminal is attached', async () => {
    // The refusal must be tied to "nobody can answer", not to the constructor
    // being called at all: with a terminal the prompt still goes out.
    stdinTty.isTTY = true;
    const io = createCliProviderIO(process.cwd());

    expect(io.interactive).toBe(true);
  });
});
