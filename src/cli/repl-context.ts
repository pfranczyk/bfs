let _replMode = false;

/**
 * Marks the current process as running inside the interactive REPL.
 * Must be called by startRepl() before the command loop begins.
 */
export function setReplMode(): void {
  _replMode = true;
}

/**
 * Returns true if the current command is being executed inside the REPL.
 * Used to enable interactive prompts (e.g. on skipped files) instead of hard errors.
 */
export function isReplMode(): boolean {
  return _replMode;
}
