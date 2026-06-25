/**
 * Shared test helpers for CLI command tests.
 *
 * Pattern: build Commander program with exitOverride, parse tokens,
 * capture stdout/stderr via vi.spyOn(console, ...).
 */

import { AbortPromptError, ExitPromptError } from '@inquirer/core';
import { Command } from 'commander';
import { vi } from 'vitest';
// Side-effect imports: register built-in providers in the global registry.
// In production src/index.ts does this; the test harness mirrors it.
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';
import { registerClear } from '../../src/cli/commands/clear.js';
import { registerConfig } from '../../src/cli/commands/config.js';
import { registerInit } from '../../src/cli/commands/init.js';
import { registerProviderAdd } from '../../src/cli/commands/provider-add.js';
import { registerProviderEdit } from '../../src/cli/commands/provider-edit.js';
import { registerProviderList } from '../../src/cli/commands/provider-list.js';
import { registerProviderRemove } from '../../src/cli/commands/provider-remove.js';
import { registerPrune } from '../../src/cli/commands/prune.js';
import { registerPull } from '../../src/cli/commands/pull.js';
import { registerPush } from '../../src/cli/commands/push.js';
import { registerRecovery } from '../../src/cli/commands/recovery.js';
import { registerScheme } from '../../src/cli/commands/scheme.js';
import { registerStatus } from '../../src/cli/commands/status.js';
import { registerVerify } from '../../src/cli/commands/verify.js';
import { registerVersions } from '../../src/cli/commands/versions.js';
import { CommandAbort } from '../../src/cli/ui.js';
import { PushMode } from '../../src/types/index.js';

/** Applies exitOverride recursively so no sub-command calls process.exit(). */
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}

/** Builds a fresh Commander program with all commands registered. */
export function buildTestProgram(): Command {
  const program = new Command();
  program
    .name('bfs')
    .allowUnknownOption(false)
    // Mirrors the global flags registered in src/index.ts:buildProgram so
    // that command tests can exercise `--cwd` / `--lang` paths.
    .option('--cwd <dir>', 'override working directory')
    .option('--lang <code>', 'language code');

  registerInit(program);
  registerClear(program);
  registerConfig(program);
  registerPush(program);
  registerPull(program);
  registerStatus(program);
  registerVersions(program);
  registerPrune(program);
  registerVerify(program);
  registerRecovery(program);
  registerScheme(program);

  const providerCmd = program.command('provider').description('Zarządzaj providerami');
  registerProviderAdd(providerCmd);
  registerProviderList(providerCmd);
  registerProviderEdit(providerCmd);
  registerProviderRemove(providerCmd);

  applyExitOverride(program);
  return program;
}

/**
 * Runs a CLI command string and returns whether it threw CommandAbort.
 * Logs and errors are captured via spies — assert on them in tests.
 *
 * @returns 'abort' | 'ok' | 'commander' | 'cancelled'
 */
export async function runCmd(tokens: string[]): Promise<'abort' | 'ok' | 'commander' | 'cancelled'> {
  const program = buildTestProgram();
  try {
    await program.parseAsync(['node', 'bfs', ...tokens]);
    return 'ok';
  } catch (err) {
    if (err instanceof CommandAbort) return 'abort';
    if (err instanceof AbortPromptError || err instanceof ExitPromptError) return 'cancelled';
    if (err instanceof Error && 'code' in err && String((err as { code: unknown }).code).startsWith('commander.')) return 'commander';
    throw err;
  }
}

/**
 * Spy on console.log and console.error for a test block.
 * Returns captured lines (stripped of ANSI codes).
 */
export function captureConsole(): { logs: string[]; errors: string[]; restore: () => void } {
  const logs: string[] = [];
  const errors: string[] = [];
  const stripAnsi = (s: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI stripping
    s.replace(/\x1B\[[0-9;]*m/g, '');

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(stripAnsi(args.map(String).join(' ')));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(stripAnsi(args.map(String).join(' ')));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    errors.push(stripAnsi(args.map(String).join(' ')));
  });

  return {
    logs,
    errors,
    restore: () => {
      logSpy.mockRestore();
      errSpy.mockRestore();
      warnSpy.mockRestore();
    },
  };
}

/** Minimal vault config fixture. */
export function makeConfig(overrides: object = {}) {
  return {
    vault_name: 'test-vault',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, kdf: 'argon2id' as const },
    push_mode: PushMode.NewVersion,
    providers: [
      { id: 'dysk-1', type: 'local', config: { path: '/tmp/d1' } },
      { id: 'dysk-2', type: 'local', config: { path: '/tmp/d2' } },
      { id: 'dysk-3', type: 'local', config: { path: '/tmp/d3' } },
    ],
    ...overrides,
  };
}
