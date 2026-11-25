import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMaxRamFlag, validateMaxRamAnswer } from '../../src/cli/parse-max-ram.js';
import { CommandAbort } from '../../src/cli/ui.js';
import { setLang } from '../../src/i18n/index.js';
import { captureConsole } from './_helpers.js';

// The values a RAM limit must not take: text, a number with trailing text, a
// negative number, zero, a fraction, exponent notation and nothing at all.
// Zero is refused rather than read as auto: push takes it as a zero budget.
const BAD_VALUES = ['abc', '512abc', '-5', '0', '1.5', '1e3', ''];

describe('parseMaxRamFlag', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
  });

  afterEach(() => {
    capture.restore();
    setLang('en');
  });

  it.each([
    ['1', 1],
    ['512', 512],
    ['65536', 65536],
  ])('should accept "%s" as %i MB', (value, expected) => {
    const result = parseMaxRamFlag(value);

    expect(result).toBe(expected);
    expect(capture.errors).toEqual([]);
  });

  it.each(BAD_VALUES)('should refuse "%s" with a CommandAbort naming the value', (value) => {
    expect(() => parseMaxRamFlag(value)).toThrow(CommandAbort);

    expect(capture.errors.join('\n')).toContain(`--max-ram must be an integer >= 1 (MB), got "${value}".`);
  });

  it('should refuse in Polish when the language is Polish', () => {
    setLang('pl');

    expect(() => parseMaxRamFlag('abc')).toThrow(CommandAbort);

    expect(capture.errors.join('\n')).toContain('--max-ram musi być liczbą całkowitą >= 1 (MB), podano "abc".');
  });
});

describe('validateMaxRamAnswer', () => {
  afterEach(() => {
    setLang('en');
  });

  it.each(['1', '512', '65536'])('should accept "%s"', (value) => {
    const result = validateMaxRamAnswer(value);

    expect(result).toBe(true);
  });

  it.each(BAD_VALUES)('should refuse "%s" with the prompt message', (value) => {
    const result = validateMaxRamAnswer(value);

    expect(result).toBe('RAM limit must be an integer >= 1 (MB).');
  });

  it('should refuse in Polish when the language is Polish', () => {
    setLang('pl');

    const result = validateMaxRamAnswer('abc');

    expect(result).toBe('Limit RAM musi być liczbą całkowitą >= 1 (MB).');
  });
});
