import path from 'node:path';
import type { Command } from 'commander';

interface GlobalOpts {
  cwd?: string;
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
