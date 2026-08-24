import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import inquirer from 'inquirer';
import { BfsError } from '../core/errors.js';
import { fmt } from '../i18n/index.js';
import { isCiDeclared } from './interactive-mode.js';

export { inquirer };

/**
 * Reports whether an error is an Inquirer prompt cancellation - Esc
 * (AbortPromptError) or Ctrl+C / closed stdin (ExitPromptError).
 *
 * Checks both `instanceof` and the error's constructor name. A bundled build
 * (tsup) inlines its own copy of `@inquirer/core`, so the class the runtime
 * `inquirer` dependency throws is a different identity than the one imported
 * here and `instanceof` alone returns false in `dist/`. The constructor-name
 * fallback recognizes the cancellation regardless of which copy produced it,
 * so cancellations stay silent in the published package, not only under tsx.
 *
 * @param err - Error caught from a prompt call
 * @returns true if `err` is a prompt cancellation, false otherwise
 */
export function isPromptCancellation(err: unknown): boolean {
  if (err instanceof AbortPromptError || err instanceof ExitPromptError) return true;
  return err instanceof Error && (err.constructor.name === 'AbortPromptError' || err.constructor.name === 'ExitPromptError');
}

// Question type is taken from inquirer.prompt signature - avoids importing
// QuestionCollection which is not exported as a named member in all inquirer versions.
type InquirerQuestions = Parameters<(typeof inquirer)['prompt']>[0];

/**
 * Text of the first question in a collection, for a refusal that names what was
 * about to be asked. The collection is typed loosely by inquirer, so the message
 * is read defensively and an empty string stands in when it is not a plain one.
 */
function _firstQuestionMessage(questions: InquirerQuestions): string {
  const first = Array.isArray(questions) ? questions[0] : questions;
  const message = (first as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? message : '';
}

/**
 * Calls inquirer.prompt() and restores terminal raw mode afterwards.
 * When inquirer closes its internal readline it calls setRawMode(false),
 * which flips the terminal back to cooked mode with OS-level echo. Without
 * restoring raw mode, characters typed in the REPL during async operations
 * end up in the wrong places on screen.
 *
 * Listens for Escape (standalone 0x1b, 1 byte) and cancels the prompt via
 * AbortController (ui.close()). That yields an AbortPromptError instead of
 * ExitPromptError - no ugly "X User force closed..." message. Ctrl+C still
 * produces ExitPromptError with the force-close message. Arrow keys
 * (\x1b[A etc.) arrive as 3+ bytes and are ignored.
 *
 * Refuses outright in a run that declared `--ci`. That declaration is a promise
 * that nothing will be asked, so arriving here is a fault of the invocation, not
 * an occasion to ask: the question would never be answered, the event loop would
 * empty, and the process would die where it stands. Commands are expected to
 * catch the missing piece earlier and name the flag that carries it - this is
 * the backstop for the one that forgets, and it says which question it was.
 *
 * @param questions - Inquirer question collection
 * @returns User answers
 * @throws BfsError when the run declared `--ci`
 */
export async function promptWithRawMode<T extends Record<string, unknown>>(questions: InquirerQuestions): Promise<T> {
  if (isCiDeclared()) throw new BfsError(fmt('prompt_no_operator_ci', _firstQuestionMessage(questions)));
  const promptResult = inquirer.prompt<T>(questions);
  const escHandler = (data: Buffer): void => {
    // Standalone Escape = 1 byte 0x1b; arrow keys = 3+ bytes (\x1b[A etc.)
    // ui.close() aborts via AbortController -> AbortPromptError (no ugly message).
    if (data.length === 1 && data[0] === 0x1b) {
      (promptResult as unknown as { ui: { close(): void } }).ui.close();
    }
  };
  process.stdin.on('data', escHandler);
  try {
    const answers = await promptResult;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    return answers as T;
  } finally {
    process.stdin.removeListener('data', escHandler);
  }
}
