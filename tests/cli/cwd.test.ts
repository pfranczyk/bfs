import { describe, expect, it } from 'vitest';
import { assertWorkingDirectoryGiven, parseCwdFlag } from '../../src/cli/cwd.js';
import { CommandAbort } from '../../src/cli/ui.js';

describe('parseCwdFlag', () => {
  it('should read the value from the spaced spelling', () => {
    expect(parseCwdFlag(['--cwd', '/some/dir', 'status'])).toBe('/some/dir');
  });

  it('should read the value from the = spelling', () => {
    expect(parseCwdFlag(['--cwd=/some/dir', 'status'])).toBe('/some/dir');
  });

  it('should return undefined when the flag is absent', () => {
    expect(parseCwdFlag(['status'])).toBeUndefined();
  });

  it('should return undefined when the spaced spelling has no following token', () => {
    expect(parseCwdFlag(['--cwd'])).toBeUndefined();
  });

  it('should return an empty string for --cwd= with nothing after the =', () => {
    expect(parseCwdFlag(['--cwd=', 'status'])).toBe('');
  });

  it('should prefer the spaced spelling when both are present, matching first-token order', () => {
    // Degenerate input (an operator would not write both), but the parser must
    // pick deterministically rather than let the last match silently win.
    expect(parseCwdFlag(['--cwd', '/first', '--cwd=/second'])).toBe('/first');
  });
});

// Otherwise only covered by smoke F16-F18: pins the swallowed-flag refusal and
// the accept path directly, at the unit level, alongside parseCwdFlag above.
describe('assertWorkingDirectoryGiven', () => {
  it('should refuse when the value looks like another flag', () => {
    expect(() => assertWorkingDirectoryGiven(['--cwd', '--version'])).toThrow(CommandAbort);
  });

  it('should accept a real directory value without throwing', () => {
    expect(() => assertWorkingDirectoryGiven(['--cwd', '/some/dir', 'status'])).not.toThrow();
  });

  it('should accept the = spelling with a real directory value without throwing', () => {
    expect(() => assertWorkingDirectoryGiven(['--cwd=/some/dir', 'status'])).not.toThrow();
  });

  it('should do nothing when the flag is absent', () => {
    expect(() => assertWorkingDirectoryGiven(['status'])).not.toThrow();
  });
});
