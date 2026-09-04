import path from 'node:path';
import type { Command } from 'commander';
import { t } from '../i18n/index.js';
import { CommandAbort, error } from './ui.js';

interface GlobalOpts {
  cwd?: string;
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
  const spaced = tokens.indexOf('--cwd');
  const value = spaced !== -1 ? tokens[spaced + 1] : tokens.find((token) => token.startsWith('--cwd='))?.slice('--cwd='.length);
  if (spaced === -1 && value === undefined) return;
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
