import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePushModeFlag } from '../../src/cli/parse-push-mode.js';
import { CommandAbort } from '../../src/cli/ui.js';
import { PushMode } from '../../src/types/index.js';
import { captureConsole } from './_helpers.js';

describe('parsePushModeFlag', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
  });

  it.each([
    ['new_version', PushMode.NewVersion],
    ['overwrite', PushMode.Overwrite],
    ['ask', PushMode.Ask],
  ])('should accept "%s"', (value, expected) => {
    const result = parsePushModeFlag(value);

    expect(result).toBe(expected);
    expect(capture.errors).toEqual([]);
  });

  // Push treats any value it does not know as new_version, so a near-miss
  // spelling must be refused here rather than stored and silently ignored.
  it.each(['sometimes', 'OVERWRITE', 'new-version', ''])('should refuse "%s" with a CommandAbort naming the allowed values', (value) => {
    expect(() => parsePushModeFlag(value)).toThrow(CommandAbort);

    const all = capture.errors.join('\n');
    expect(all).toMatch(/Invalid --push-mode|Nieprawidłowy --push-mode/);
    expect(all).toContain('new_version|overwrite|ask');
  });
});
