import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { isCiDeclared, registerCiModeHook } from '../../src/cli/interactive-mode.js';
import { promptWithRawMode } from '../../src/cli/prompt.js';
import { BfsError } from '../../src/core/errors.js';

// Commands catch a missing piece on the command line and name the flag that
// carries it, so under `--ci` none of them should reach a prompt at all. This
// pins the layer underneath that: the prompt helper itself refuses, so a command
// added later without its own guard fails saying which question it was, instead
// of stopping on a question nobody will answer.
//
// Nothing else pins it. The command tests replace promptWithRawMode with a
// sentinel (they are about the earlier refusal), and no shipped command can
// reach it under `--ci` any more - which is the point, and also why the net is
// invisible unless something like this holds it.
//
// The mode is read from module state that registerCiModeHook fills, so the
// program here is wired exactly as buildProgram wires the real one. A test that
// skipped the hook would prove only that the state defaults to false.

/** Builds a program whose one command walks straight into a prompt. */
function programAskingAQuestion(): { program: Command; asked: string[] } {
  const asked: string[] = [];
  const program = new Command();
  program.name('bfs').option('--ci', 'never prompt');
  registerCiModeHook(program);
  program.command('ask').action(async () => {
    await promptWithRawMode<{ value: string }>([{ type: 'input', name: 'value', message: 'Which storage?' }]);
    asked.push('Which storage?');
  });
  program.exitOverride();
  for (const sub of program.commands) sub.exitOverride();
  return { program, asked };
}

describe('the prompt helper as the last line under --ci', () => {
  it('should refuse the question and name it when the run declared --ci', async () => {
    const { program, asked } = programAskingAQuestion();

    const err = await program.parseAsync(['node', 'bfs', '--ci', 'ask']).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BfsError);
    expect(String(err)).toContain('Which storage?');
    expect(asked).toEqual([]);
    // This helper reads the declaration and nothing else, so the refusal names
    // only that. Offering a missing terminal as a second possible cause would
    // send an operator who does have one looking at the wrong thing; the wording
    // that does carry both causes belongs to the provider IO, which reads both.
    expect(String(err)).toContain('(--ci)');
    expect(String(err)).not.toContain('no terminal attached');
  });

  it('should refuse the same way when --ci follows the sub-command', async () => {
    const { program } = programAskingAQuestion();

    const err = await program.parseAsync(['node', 'bfs', 'ask', '--ci']).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(BfsError);
  });

  // The other half, observed on the state rather than on the prompt: without the
  // declaration the helper hands the question to inquirer as before. Running that
  // command here would prove it by hanging - which is exactly what the guard
  // exists to prevent, and no way to end a test - so what is asserted is the
  // input the guard reads.
  it('should leave the mode undeclared when --ci was not typed', async () => {
    const program = new Command();
    program.name('bfs').option('--ci', 'never prompt');
    registerCiModeHook(program);
    let seen: Nullable<boolean> = null;
    program.command('quiet').action(() => {
      seen = isCiDeclared();
    });
    program.exitOverride();
    for (const sub of program.commands) sub.exitOverride();

    await program.parseAsync(['node', 'bfs', 'quiet']);

    expect(seen).toBe(false);
  });

  it('should declare the mode for a command that carries --ci', async () => {
    const program = new Command();
    program.name('bfs').option('--ci', 'never prompt');
    registerCiModeHook(program);
    let seen: Nullable<boolean> = null;
    program.command('quiet').action(() => {
      seen = isCiDeclared();
    });
    program.exitOverride();
    for (const sub of program.commands) sub.exitOverride();

    await program.parseAsync(['node', 'bfs', 'quiet', '--ci']);

    expect(seen).toBe(true);
  });
});
