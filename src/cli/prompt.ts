import inquirer from 'inquirer';

export { inquirer };

// Typ pytań pobieramy z sygnatury inquirer.prompt — unikamy importu QuestionCollection
// który nie jest eksportowany jako named member we wszystkich wersjach inquirer
type InquirerQuestions = Parameters<(typeof inquirer)['prompt']>[0];

/**
 * Wywołuje inquirer.prompt() i przywraca raw mode terminala po zakończeniu.
 * Inquirer przy zamknięciu swojego wewnętrznego readline wywołuje setRawMode(false),
 * co przełącza terminal w cooked mode z OS-level echo. Bez przywrócenia raw mode
 * znaki wpisywane w REPL podczas operacji asynchronicznych pojawiają się w złych
 * miejscach na ekranie.
 *
 * Nasłuchuje na klawisz Escape (standalone 0x1b, 1 bajt) i anuluje prompt
 * przez AbortController (ui.close()). Daje to AbortPromptError zamiast
 * ExitPromptError — bez brzydkiego komunikatu "✗ User force closed...".
 * Ctrl+C nadal daje ExitPromptError z komunikatem (force close).
 * Arrow keys (\x1b[A etc.) przychodzą jako 3+ bajtów i są ignorowane.
 *
 * @param questions - Kolekcja pytań Inquirer
 * @returns Odpowiedzi użytkownika
 */
export async function promptWithRawMode<T extends Record<string, unknown>>(
  questions: InquirerQuestions,
): Promise<T> {
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
