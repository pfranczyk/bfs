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
 * @param questions - Kolekcja pytań Inquirer
 * @returns Odpowiedzi użytkownika
 */
export async function promptWithRawMode<T extends Record<string, unknown>>(
  questions: InquirerQuestions,
): Promise<T> {
  const answers = await inquirer.prompt<T>(questions);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  return answers as T;
}
