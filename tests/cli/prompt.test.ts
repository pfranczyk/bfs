import { AbortPromptError as RealAbortPromptError, ExitPromptError as RealExitPromptError } from '@inquirer/core';
import { describe, expect, it } from 'vitest';
import { isPromptCancellation } from '../../src/cli/prompt.js';

describe('isPromptCancellation', () => {
  it('should recognize a real ExitPromptError instance', () => {
    expect(isPromptCancellation(new RealExitPromptError('User force closed the prompt'))).toBe(true);
  });

  it('should recognize a real AbortPromptError instance', () => {
    expect(isPromptCancellation(new RealAbortPromptError())).toBe(true);
  });

  // Regression: a bundled build (tsup) inlines its own copy of @inquirer/core,
  // so the cancellation thrown by the runtime `inquirer` dependency is an
  // instance of a DIFFERENT class identity than the one imported in source —
  // `instanceof` alone returns false in dist/. The constructor-name fallback
  // must still classify it as a cancellation, or the published package leaks
  // "✗ User force closed the prompt" to stderr on a non-interactive prompt
  // (e.g. `bfs prune` with closed stdin). This case fails on an instanceof-only
  // check and passes only with the fallback.
  it('should recognize a foreign cancellation class by constructor name', () => {
    class ExitPromptError extends Error {}
    class AbortPromptError extends Error {}
    const foreignExit = new ExitPromptError();
    const foreignAbort = new AbortPromptError();

    expect(foreignExit instanceof RealExitPromptError).toBe(false);
    expect(isPromptCancellation(foreignExit)).toBe(true);
    expect(isPromptCancellation(foreignAbort)).toBe(true);
  });

  it('should not treat an unrelated error as a cancellation', () => {
    expect(isPromptCancellation(new Error('disk full'))).toBe(false);
  });

  it('should not treat a non-error value as a cancellation', () => {
    expect(isPromptCancellation('User force closed the prompt')).toBe(false);
    expect(isPromptCancellation(null)).toBe(false);
    expect(isPromptCancellation(undefined)).toBe(false);
  });
});
