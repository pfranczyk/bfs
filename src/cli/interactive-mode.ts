import type { Command } from 'commander';

interface GlobalCiOpts {
  ci?: boolean;
}

/**
 * Reports whether this run declared that it will not be prompted - `bfs --ci`
 * on the program, or a command's own `--ci` where one exists.
 *
 * The declaration is the ONLY thing that makes a run non-interactive by intent;
 * a flag that merely supplies data (`--bootstrap`, `--strategy`, `--password`)
 * never does. Supplying what a command needs removes the reason to ask, which
 * is not the same as forbidding the question: an operator who leaves something
 * out at a terminal is still asked for it. Conflating the two took the password
 * prompt away from `bfs provider remove --strategy` at a live terminal and told
 * the operator there was no terminal.
 *
 * Whether anyone CAN answer is a separate question, answered by the terminal
 * check in `createCliProviderIO`. Both lead to the same place - no prompt is
 * issued - but only this one is a promise the operator made, and only it turns
 * an incomplete command into an error instead of a question.
 *
 * @param cmd       - Commander Command instance (last argument in an action callback)
 * @param commandCi - value of the command's own `--ci`, where it has one
 * @returns true when the run must not prompt for anything
 */
export function isCiRun(cmd: Command, commandCi?: boolean): boolean {
  if (commandCi === true) return true;
  const { ci } = cmd.optsWithGlobals<GlobalCiOpts>();
  return ci === true;
}

/**
 * Whether the command line now running declared `--ci`. Answers the same
 * question as {@link isCiRun} for callers that have no Command in reach - the
 * CLI's own prompt helper, which is several frames below any action handler.
 */
let ciDeclared = false;

/**
 * Records the declaration for the command about to run, and answers `false`
 * until one does.
 *
 * Reading it off Commander rather than off `process.argv` is what makes the flag
 * position-independent for free: `optsWithGlobals` merges the program's `--ci`
 * with a command's own, wherever the operator typed it, and a `--ci` inside a
 * quoted spec passed through to an adapter is never a token of this command
 * line, so it stays the adapter's text. Registration resets the state, and each
 * command line builds its own program - including every line typed at the REPL.
 *
 * @param program - Commander program to attach the hook to
 */
export function registerCiModeHook(program: Command): void {
  ciDeclared = false;
  program.hook('preAction', (_program: Command, actionCommand: Command) => {
    ciDeclared = isCiRun(actionCommand);
  });
}

/**
 * Reports whether the running command declared `--ci`.
 *
 * @returns true when this command line promised that nothing would be asked
 */
export function isCiDeclared(): boolean {
  return ciDeclared;
}
