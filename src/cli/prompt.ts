import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import inquirer from 'inquirer';

export { inquirer };

/**
 * Reports whether an error is an Inquirer prompt cancellation — Esc
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

// Question type is taken from inquirer.prompt signature — avoids importing
// QuestionCollection which is not exported as a named member in all inquirer versions.
type InquirerQuestions = Parameters<(typeof inquirer)['prompt']>[0];

/**
 * Calls inquirer.prompt() and restores terminal raw mode afterwards.
 * When inquirer closes its internal readline it calls setRawMode(false),
 * which flips the terminal back to cooked mode with OS-level echo. Without
 * restoring raw mode, characters typed in the REPL during async operations
 * end up in the wrong places on screen.
 *
 * Listens for Escape (standalone 0x1b, 1 byte) and cancels the prompt via
 * AbortController (ui.close()). That yields an AbortPromptError instead of
 * ExitPromptError — no ugly "✗ User force closed..." message. Ctrl+C still
 * produces ExitPromptError with the force-close message. Arrow keys
 * (\x1b[A etc.) arrive as 3+ bytes and are ignored.
 *
 * @param questions - Inquirer question collection
 * @returns User answers
 */
export async function promptWithRawMode<T extends Record<string, unknown>>(questions: InquirerQuestions): Promise<T> {
  const promptResult = inquirer.prompt<T>(questions);
  const escHandler = (data: Buffer): void => {
    // Standalone Escape = 1 byte 0x1b; arrow keys = 3+ bytes (\x1b[A etc.)
    // ui.close() aborts via AbortController → AbortPromptError (no ugly message).
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
