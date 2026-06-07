import fs from 'node:fs/promises';
import { ProviderError } from '../core/errors.js';

/**
 * Helpers for provider adapters that opt in to a `--flag value` style of
 * `CliProviderInput.rawArgs`. These are *convenience*, not a contract — BFS
 * never calls them, never inspects rawArgs itself. An adapter is free to
 * choose a different flag shape (repeated values, positional args, a JSON
 * blob on stdin, …) and ignore these helpers entirely.
 *
 * The built-in FTP and LocalFS adapters both accept `--config-file <path>`,
 * so factor the parsing + JSON loading out once to keep their
 * configureFromFlags bodies readable.
 */

/**
 * Finds the first `flagName value` pair in rawArgs and returns the value,
 * or null when the flag is absent. Case-sensitive; the flag must appear
 * immediately before its value (no `=` form).
 */
export function findStringFlag(rawArgs: readonly string[], flagName: string): Nullable<string> {
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === flagName && i + 1 < rawArgs.length) {
      return rawArgs[i + 1];
    }
  }
  return null;
}

/**
 * Reads a JSON file and returns it as a plain object. Throws
 * `ProviderError` with the given `adapterLabel` prefix when the file
 * cannot be read, is not valid JSON, or does not decode to a plain object.
 *
 * `adapterLabel` should identify the adapter in the message so users can
 * tell whose configuration failed (e.g. `"FTP adapter"`, `"Local adapter"`).
 */
export async function readJsonObjectFile(absolutePath: string, adapterLabel: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(absolutePath, 'utf8');
  } catch (err) {
    throw new ProviderError(`${adapterLabel}: cannot read "${absolutePath}": ` + `${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProviderError(`${adapterLabel}: "${absolutePath}" is not valid JSON: ` + `${err instanceof Error ? err.message : String(err)}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    throw new ProviderError(`${adapterLabel}: "${absolutePath}" must contain a JSON object (got ${kind})`);
  }

  return parsed as Record<string, unknown>;
}
