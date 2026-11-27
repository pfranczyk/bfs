import { availableLangs, fmt, isKnownLang, setLang, t } from '../i18n/index.js';
import { CommandAbort, error, warn } from './ui.js';

const LANG_FLAG = '--lang';
const LANG_FLAG_EQUALS = `${LANG_FLAG}=`;

/** The language flag read off the command line, and the line without it. */
export interface LangFlag {
  /** Whether the flag appeared at all, in either spelling. */
  readonly given: boolean;
  /** The value that came with it, verbatim; null when the flag is absent or the spaced spelling ends the line. */
  readonly value: Nullable<string>;
  /** The tokens with the flag (and its value) taken out. */
  readonly rest: string[];
}

/**
 * Reads the language flag in either spelling, `--lang <code>` or
 * `--lang=<code>`, and returns the tokens with it taken out. The flag has to be
 * settled before the program is built - every description is translated at
 * that point - so it is read here rather than left to the argument parser, and
 * removed so nothing reads it a second time. Both spellings go through this one
 * reader: a spelling it missed would reach the parser, be accepted there and
 * read by nobody, and the run would carry on in the old language without a
 * word. Only the first occurrence counts. The value is not validated - an empty
 * or flag-like one comes back verbatim for {@link resolveLanguage} to judge.
 *
 * @param tokens - argv tokens after the program name
 * @returns whether the flag was given, its raw value, and the remaining tokens
 */
export function extractLangFlag(tokens: string[]): LangFlag {
  const at = tokens.findIndex((token) => token === LANG_FLAG || token.startsWith(LANG_FLAG_EQUALS));
  if (at === -1) return { given: false, value: null, rest: tokens };
  const token = tokens[at];
  if (token !== LANG_FLAG) {
    return { given: true, value: token.slice(LANG_FLAG_EQUALS.length), rest: tokens.filter((_, i) => i !== at) };
  }
  const value = tokens[at + 1] ?? null;
  const taken = value === null ? 1 : 2;
  return { given: true, value, rest: tokens.filter((_, i) => i < at || i >= at + taken) };
}

/**
 * Settles which language the interface runs in, refusing a `--lang` that cannot
 * be honoured. The interface exists in a fixed set of languages, so a value
 * outside it is a mistake to report rather than a preference to store: written
 * through, it would drop the interface back to English on this run and every run
 * after it, with nothing on screen tying that back to the flag that did it.
 * Asking for the flag and leaving the value out entirely is a different mistake -
 * nothing was given to reject, so it is named as a missing value, not answered
 * with the same "invalid value" wording an unknown language gets.
 *
 * The refusal speaks the language already in force - never the one being asked
 * for, which is exactly the one that cannot be rendered. The returned tag is
 * always one the interface has, because it travels on to every adapter through
 * the provider registry.
 *
 * @param flagGiven - whether `--lang` appeared at all
 * @param cliLang   - the value that came with it, if any (see {@link extractLangFlag})
 * @param stored    - the language saved in the global settings
 * @returns a language tag the interface can actually render
 * @throws CommandAbort when `--lang` was given with no value (or an empty one),
 *         or with a value the interface does not have
 */
export function resolveLanguage(flagGiven: boolean, cliLang: string | undefined, stored: Nullable<string>): string {
  if (flagGiven) {
    if (cliLang === undefined || cliLang === '') {
      setLang(stored !== null && isKnownLang(stored) ? stored : 'en');
      error(t('lang_value_missing'));
      throw new CommandAbort();
    }
    if (!isKnownLang(cliLang)) {
      setLang(stored !== null && isKnownLang(stored) ? stored : 'en');
      error(fmt('lang_invalid', cliLang, availableLangs().join(', ')));
      throw new CommandAbort();
    }
  }
  const requested = cliLang ?? stored ?? 'en';
  return isKnownLang(requested) ? requested : 'en';
}

/**
 * Points out a saved language the interface cannot render, once per run. The
 * settings file is plain JSON that anything can write, so it may name a language
 * this build does not carry; that is a preference rather than backup data, so it
 * is said out loud - with the command that replaces it - and the work carries on
 * in English instead of stopping. Silent otherwise, including when `--lang` was
 * given on this run, which settles the language by itself.
 *
 * @param cliLang - the language requested on the command line, if any
 * @param stored  - the language saved in the global settings
 */
export function reportUnusableStoredLanguage(cliLang: string | undefined, stored: Nullable<string>): void {
  if (cliLang !== undefined) return;
  // A settings file written by hand may carry no language key at all, which is
  // not the same as one holding a language nobody has.
  const saved = stored ?? null;
  if (saved === null || isKnownLang(saved)) return;
  warn(fmt('lang_stored_unusable', saved));
}
