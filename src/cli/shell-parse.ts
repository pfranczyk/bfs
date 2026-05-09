import { BfsError } from '../core/errors.js';

/**
 * Tokenizes a shell-like spec string into argv-style tokens.
 *
 * Semantics — quoting only, no expansion, no shell-style escape outside quotes:
 *   - whitespace (space, tab, newline) separates tokens
 *   - `'...'` wraps a literal token (no escapes inside)
 *   - `"..."` wraps a token; `\"` and `\\` are the only recognized escapes
 *   - outside quotes, every character is literal — including `\`. Windows
 *     paths inline (`--path D:\backup\p1`) work without escaping. Values
 *     with embedded spaces still need quoting (`--path 'my disk'`).
 *   - no variable expansion, no command substitution, no globbing
 *
 * Adjacent quoted and unquoted fragments join into one token
 * (e.g. `foo"bar baz"` → `foo bar baz` as a single token).
 *
 * @param input - the raw CLI spec, typically the value of `--provider`
 * @returns      tokens in input order
 * @throws BfsError on an unclosed quote
 */
export function shellParse(input: string): string[] {
  const tokens: string[] = [];
  let buf = '';
  let inToken = false;
  let quote: Nullable<string> = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === '\\' && quote === '"') {
        const next = input[i + 1];
        if (next === '"' || next === '\\') {
          buf += next;
          i++;
          continue;
        }
      }
      buf += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inToken) {
        tokens.push(buf);
        buf = '';
        inToken = false;
      }
      continue;
    }
    buf += ch;
    inToken = true;
  }

  if (quote !== null) {
    throw new BfsError(`Unclosed ${quote} quote in spec: "${input}"`);
  }
  if (inToken) {
    tokens.push(buf);
  }
  return tokens;
}
