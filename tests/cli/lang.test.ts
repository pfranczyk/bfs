import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLanguage } from '../../src/cli/lang.js';
import { CommandAbort } from '../../src/cli/ui.js';
import { availableLangs, fmt } from '../../src/i18n/index.js';

describe('resolveLanguage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should refuse a missing value with a dedicated key, not lang_invalid', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveLanguage(true, undefined, null)).toThrow(CommandAbort);

    const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('Invalid --lang');
    expect(out).toContain(fmt('lang_value_missing'));
  });

  it('should refuse an empty value the same way as a missing one', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveLanguage(true, '', null)).toThrow(CommandAbort);

    const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).not.toContain('Invalid --lang');
    expect(out).toContain(fmt('lang_value_missing'));
  });

  it('should keep lang_invalid for a value that was given but is unknown (negative control)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => resolveLanguage(true, 'klingon', null)).toThrow(CommandAbort);

    const out = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain(fmt('lang_invalid', 'klingon', availableLangs().join(', ')));
    expect(out).not.toContain(fmt('lang_value_missing'));
  });
});
