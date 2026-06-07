/**
 * Undocumented debug mode for diagnosing stdin/Inquirer issues.
 * Enabled by passing --debug as the first argument.
 * Writes to stderr to avoid interfering with Inquirer's stdout rendering.
 */

export let debugEnabled = false;

/** Activate debug output. Called once at startup when --debug is detected. */
export function enableDebug(): void {
  debugEnabled = true;
}

/** Deactivate debug output. Used by tests that exercise the gated path. */
export function disableDebug(): void {
  debugEnabled = false;
}

/** Log a debug line to stderr (no-op unless --debug was passed). */
export function dbg(label: string, data?: Record<string, unknown>): void {
  if (!debugEnabled) return;
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
  const suffix = data
    ? ' ' +
      Object.entries(data)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ')
    : '';
  process.stderr.write(`\x1b[2m[DBG ${ts}] ${label}${suffix}\x1b[0m\n`);
}

/** Snapshot of process.stdin state — useful for diagnosing Inquirer hangs. */
export function stdinState(): Record<string, unknown> {
  return { paused: process.stdin.isPaused(), ended: process.stdin.readableEnded, destroyed: process.stdin.destroyed, listeners_data: process.stdin.listenerCount('data'), listeners_readable: process.stdin.listenerCount('readable') };
}
