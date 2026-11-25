import { fmt, t } from '../i18n/index.js';
import { CommandAbort, error } from './ui.js';

// Digits only, no leading zero: a whole number of MiB above zero. Zero is not
// read as auto - push takes a stored zero as a zero budget, so accepting it
// would store a value that means something other than it seems to.
const MAX_RAM_PATTERN = /^[1-9]\d*$/;

/**
 * Checks a `--max-ram` value. Only a whole number of MiB above zero, written
 * in plain digits without a leading zero, is accepted; text, a
 * number with trailing text, a fraction, exponent notation, a negative number,
 * zero and an empty value are refused before anything is written or uploaded.
 *
 * @param value - Value given on the command line
 * @returns The RAM limit in MiB
 * @throws CommandAbort after printing which value was refused and what is accepted
 */
export function parseMaxRamFlag(value: string): number {
  if (!isMaxRamValue(value)) {
    error(fmt('max_ram_invalid', value));
    throw new CommandAbort();
  }
  return Number(value);
}

/**
 * Validator for the RAM limit question of an interactive `bfs init`; accepts
 * exactly what `parseMaxRamFlag` accepts.
 *
 * @param value - Answer typed at the prompt
 * @returns true when the answer is accepted, otherwise the message to show
 */
export function validateMaxRamAnswer(value: string): true | string {
  return isMaxRamValue(value) ? true : t('max_ram_prompt_invalid');
}

/**
 * Converts an answer already accepted by `validateMaxRamAnswer` to MiB.
 *
 * @param value - Accepted answer
 * @returns The RAM limit in MiB
 * @throws Error when the answer did not pass the validator
 */
export function maxRamAnswerToMb(value: string): number {
  if (!isMaxRamValue(value)) throw new Error(`RAM limit answer "${value}" did not pass validateMaxRamAnswer`);
  return Number(value);
}

function isMaxRamValue(value: string): boolean {
  return MAX_RAM_PATTERN.test(value) && Number.isSafeInteger(Number(value));
}
