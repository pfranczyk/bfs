import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractLangFlag, resolveLanguage } from '../../src/cli/lang.js';
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

describe('extractLangFlag', () => {
  it('should read the spaced spelling and take the flag and its value out', () => {
    expect(extractLangFlag(['--lang', 'pl', 'status'])).toEqual({ given: true, value: 'pl', rest: ['status'] });
  });

  it('should read the equals spelling and take the single token out', () => {
    expect(extractLangFlag(['--lang=pl', 'status'])).toEqual({ given: true, value: 'pl', rest: ['status'] });
  });

  it('should read the flag wherever it stands on the line', () => {
    expect(extractLangFlag(['status', '--lang=pl'])).toEqual({ given: true, value: 'pl', rest: ['status'] });
    expect(extractLangFlag(['--cwd', 'dir', '--lang', 'en', 'status'])).toEqual({ given: true, value: 'en', rest: ['--cwd', 'dir', 'status'] });
  });

  it('should hand back an empty equals value verbatim, for the caller to refuse as missing', () => {
    expect(extractLangFlag(['--lang=', 'status'])).toEqual({ given: true, value: '', rest: ['status'] });
  });

  it('should report a spaced flag that ends the line as given without a value', () => {
    expect(extractLangFlag(['--lang'])).toEqual({ given: true, value: null, rest: [] });
  });

  it('should leave the line alone when the flag is absent, including look-alike flags', () => {
    const tokens = ['--language', 'pl', '--langx=pl', 'status'];
    expect(extractLangFlag(tokens)).toEqual({ given: false, value: null, rest: tokens });
  });

  it('should take only the first occurrence out', () => {
    expect(extractLangFlag(['--lang=pl', '--lang', 'en', 'status'])).toEqual({ given: true, value: 'pl', rest: ['--lang', 'en', 'status'] });
  });
});
