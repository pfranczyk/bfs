import { availableLangs, fmt, isKnownLang, setLang } from '../i18n/index.js';
import { CommandAbort, error, warn } from './ui.js';

/**
 * Settles which language the interface runs in, refusing a `--lang` that cannot
 * be honoured. The interface exists in a fixed set of languages, so a value
 * outside it is a mistake to report rather than a preference to store: written
 * through, it would drop the interface back to English on this run and every run
 * after it, with nothing on screen tying that back to the flag that did it.
 * Asking for the flag and leaving the value out is the same mistake arriving the
 * same way, and is answered the same.
 *
 * The refusal speaks the language already in force - never the one being asked
 * for, which is exactly the one that cannot be rendered. The returned tag is
 * always one the interface has, because it travels on to every adapter through
 * the provider registry.
 *
 * @param flagGiven - whether `--lang` appeared at all
 * @param cliLang   - the token that followed it, if any
 * @param stored    - the language saved in the global settings
 * @returns a language tag the interface can actually render
 * @throws CommandAbort when `--lang` carries a value the interface does not have,
 *         including none at all
 */
export function resolveLanguage(flagGiven: boolean, cliLang: string | undefined, stored: Nullable<string>): string {
  if (flagGiven && (cliLang === undefined || cliLang === '' || !isKnownLang(cliLang))) {
    setLang(stored !== null && isKnownLang(stored) ? stored : 'en');
    error(fmt('lang_invalid', cliLang ?? '', availableLangs().join(', ')));
    throw new CommandAbort();
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
