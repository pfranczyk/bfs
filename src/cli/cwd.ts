import path from 'node:path';
import type { Command } from 'commander';
import { t } from '../i18n/index.js';
import { CommandAbort, error } from './ui.js';

interface GlobalOpts {
  cwd?: string;
}

/**
 * Reads the value following `--cwd` in either spelling: `--cwd <dir>` or
 * `--cwd=<dir>`. Returns `undefined` when the flag is absent, or when the
 * spaced spelling has no following token. Does not validate the value - a
 * flag-like token or an empty string comes back verbatim, for the caller to
 * judge (see {@link assertWorkingDirectoryGiven}). Every reader of `--cwd`
 * (validation here, the REPL's own root-directory pre-scan in `src/index.ts`)
 * goes through this single parser, so a spelling either both recognise or both
 * miss - never one silently blind to the other.
 *
 * @param tokens - argv tokens to scan
 * @returns the raw value found, or `undefined` if the flag is not present
 */
export function parseCwdFlag(tokens: string[]): string | undefined {
  const spaced = tokens.indexOf('--cwd');
  if (spaced !== -1) return tokens[spaced + 1];
  return tokens.find((token) => token.startsWith('--cwd='))?.slice('--cwd='.length);
}

/**
 * Refuses a working-directory flag that was given without a directory. Every
 * reader treats the value as the place to work in, so one that is missing is
 * read as an answer nobody gave and the run silently continues wherever it
 * started - or lets a swallowed flag answer in its place. Both spellings are
 * checked, and an empty value counts as missing in each: `--cwd "$DIR"` and
 * `--cwd="$DIR"` with DIR unset are the same slip, and neither may pass for a
 * directory. Commander cannot stand in for this - it sees the flag only once a
 * sub-command is present, and counts a following flag as the value anyway.
 *
 * @param tokens - argv tokens after the program name
 * @throws CommandAbort when `--cwd` is present without a usable directory
 */
export function assertWorkingDirectoryGiven(tokens: string[]): void {
  const flagPresent = tokens.includes('--cwd') || tokens.some((token) => token.startsWith('--cwd='));
  if (!flagPresent) return;
  const value = parseCwdFlag(tokens);
  if (value === undefined || value === '' || value.startsWith('-')) {
    error(t('cwd_value_missing'));
    throw new CommandAbort();
  }
}

/**
 * Resolves the effective working directory for a BFS command.
 * Uses the global --cwd option if provided, otherwise falls back to process.cwd().
 * Handles relative paths via path.resolve(). Never mutates global process state.
 *
 * @param cmd - Commander Command instance (last argument in action callback)
 * @returns    Absolute path to the working directory
 */
export function resolveCwd(cmd: Command): string {
  const { cwd } = cmd.optsWithGlobals<GlobalOpts>();
  return cwd ? path.resolve(cwd) : process.cwd();
}
