import { fmt } from '../i18n/index.js';
import { PushMode } from '../types/index.js';
import { CommandAbort, error } from './ui.js';

const PUSH_MODES: readonly string[] = Object.values(PushMode);

/**
 * Checks a `--push-mode` value against the three modes push understands.
 * The match is exact: push treats any other stored value as new_version, so a
 * value accepted in another spelling would be ignored without a word.
 *
 * @param value - Value given on the command line
 * @returns The value as a `PushMode`
 * @throws CommandAbort after printing which values are allowed
 */
export function parsePushModeFlag(value: string): PushMode {
  if (!_isPushMode(value)) {
    error(fmt('init_push_mode_invalid', value));
    throw new CommandAbort();
  }
  return value;
}

function _isPushMode(value: string): value is PushMode {
  return PUSH_MODES.includes(value);
}
