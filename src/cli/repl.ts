import readline from 'node:readline';
import chalk from 'chalk';
import { dbg, stdinState } from '../debug.js';
import { fmt, t } from '../i18n/index.js';
import { readConfig } from '../vault/config.js';
import { readState } from '../vault/state.js';
import { isPromptCancellation } from './prompt.js';
import { setReplMode } from './repl-context.js';
import { CommandAbort } from './ui.js';

const COMMANDS = ['init', 'push', 'pull', 'status', 'versions', 'prune', 'verify', 'recovery', 'provider add', 'provider list', 'provider remove', 'scheme set', 'clear', 'help', 'exit', 'quit'];

/**
 * Prints the REPL welcome banner with vault info (if available).
 *
 * @param rootDir - Current working directory (vault root)
 */
async function printBanner(rootDir: string): Promise<void> {
  console.log(chalk.bold.cyan(t('repl_banner_title')));

  try {
    const config = await readConfig(rootDir);
    const state = await readState(rootDir);
    if (config) {
      console.log(`  ${t('status_name').padEnd(13)} ${chalk.cyan(config.vault_name)}`);
      console.log(`  ${t('status_scheme').padEnd(13)} ${config.scheme.data_shards}/${config.scheme.parity_shards} ${chalk.dim(fmt('repl_banner_providers', String(config.providers.length)))}`);
      console.log(`  ${t('status_latest').padEnd(13)} v${state.latest_version}`);
      console.log(`  ${t('status_on_disk').padEnd(13)} v${state.working_version}`);
      console.log(`  ${t('status_encryption').padEnd(13)} ${config.encryption.enabled ? chalk.green(t('status_enc_enabled')) : chalk.dim(t('status_enc_disabled'))}`);
    } else {
      console.log(chalk.dim(t('repl_no_config')));
    }
  } catch {
    console.log(chalk.dim(t('repl_no_config')));
  }

  console.log(chalk.dim(t('repl_banner_hint')));
}

/**
 * Prints the help text listing all available REPL commands.
 */
function printHelp(): void {
  console.log(chalk.bold(t('repl_help_header')));
  const commands: [string, string][] = [
    ['init', t('repl_help_cmd_init')],
    ['push [--new|--overwrite]', t('repl_help_cmd_push')],
    ['pull [--version <n>]', t('repl_help_cmd_pull')],
    ['status', t('repl_help_cmd_status')],
    ['versions', t('repl_help_cmd_versions')],
    ['prune <range>', t('repl_help_cmd_prune')],
    ['verify', t('repl_help_cmd_verify')],
    ['recovery --provider <t> --path <p> --name <n>', t('repl_help_cmd_recovery')],
    ['provider add', t('repl_help_cmd_provider_add')],
    ['provider list', t('repl_help_cmd_provider_list')],
    ['provider remove <id>', t('repl_help_cmd_provider_remove')],
    ['scheme set <N> <K>', t('repl_help_cmd_scheme_set')],
    ['clear', t('repl_help_cmd_clear')],
    ['help', t('repl_help_cmd_help')],
    ['exit / quit', t('repl_help_cmd_exit')],
  ];
  for (const [cmd, desc] of commands) {
    console.log(`  ${chalk.cyan(cmd.padEnd(44))} ${chalk.dim(desc)}`);
  }
  console.log();
}

/**
 * Handles an error thrown by a REPL command action.
 * Silently swallows known non-fatal errors (CommandAbort, ExitPromptError,
 * CommanderError). Logs unexpected errors to stderr.
 *
 * @param err - Error caught from runCommand
 */
function handleReplError(err: unknown): void {
  if (err instanceof CommandAbort) return;
  if (isPromptCancellation(err)) {
    console.log(chalk.dim(t('repl_cancelled')));
    return;
  }
  if (err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string' && (err as { code: string }).code.startsWith('commander.')) {
    return;
  }
  if (err instanceof Error) {
    console.error(chalk.red(fmt('repl_error_prefix', err.message)));
  }
}

/**
 * Starts the interactive BFS REPL.
 * Reads commands from stdin, parses them as Commander.js arguments,
 * and dispatches to the registered CLI commands.
 *
 * @param rootDir     - Current working directory
 * @param runCommand  - Callback that executes a parsed command line
 */
export async function startRepl(rootDir: string, runCommand: (args: string[]) => Promise<void>): Promise<void> {
  setReplMode();
  await printBanner(rootDir);

  // Inquirer v13 calls process.stdout.end() via its internal MuteStream pipe cleanup.
  // In a PTY this propagates to stdin, which kills our readline interface.
  // Suppress stdout.end() for the duration of the REPL.
  type WriteStreamWithEnd = NodeJS.WriteStream & { end: unknown };
  const origStdoutEnd = process.stdout.end.bind(process.stdout);
  (process.stdout as WriteStreamWithEnd).end = () => process.stdout;

  let closed = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 100,
    completer: (line: string): [string[], string] => {
      const hits = COMMANDS.filter((c) => c.startsWith(line));
      return [hits.length ? hits : COMMANDS, line];
    },
  });

  rl.on('close', () => {
    closed = true;
  });

  const prompt = () => {
    if (closed) return;
    rl.question(chalk.bold.cyan('bfs') + chalk.dim(' > '), async (input) => {
      const trimmed = input.trim();
      dbg('rl.question:input', { raw: JSON.stringify(input), trimmed: JSON.stringify(trimmed), empty: !trimmed, ...stdinState() });

      if (!trimmed) {
        dbg('rl.question:empty → re-prompt', stdinState());
        prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        console.log(chalk.dim(t('repl_goodbye')));
        rl.close();
        return;
      }

      if (trimmed === 'help') {
        printHelp();
        prompt();
        return;
      }

      const tokens = splitArgs(trimmed);

      // Strip leading 'bfs' prefix — users naturally type "bfs push" in the REPL
      if (tokens.length > 1 && tokens[0] === 'bfs') {
        tokens.shift();
      }

      dbg('dispatch:start', { cmd: tokens[0], ...stdinState() });

      // Detach readline's 'keypress' listener before dispatching so that
      // Inquirer gets exclusive access to keypress events.
      //
      // readline (terminal=true) receives input via 'keypress' events emitted by
      // the readline.emitKeypressEvents transformer. When Inquirer later calls
      // stdin.resume() via its own readline interface, keystrokes flow through the
      // same transformer; if our 'keypress' listener is still attached, readline
      // silently buffers them and emits a spurious empty/garbage line after the
      // command finishes. So remove only the 'keypress' listener (our readline's
      // input handler); the 'data' listener — the transformer added by
      // emitKeypressEvents — must stay, otherwise Inquirer can't receive key
      // events either. Closing readline is intentionally avoided: on Windows it
      // resets TTY raw-mode, breaking Ctrl+C inside Inquirer prompts.
      rl.pause();
      type Fn = (...args: unknown[]) => void;
      const savedKeypress = process.stdin.rawListeners('keypress') as Fn[];
      process.stdin.removeAllListeners('keypress');
      process.stdin.resume();
      dbg('stdin keypress detached', stdinState());

      // Absorb OS-level SIGINT during command dispatch. The inquirer compat
      // layer (inquirer/dist/ui/prompt.js) calls process.kill(pid, 'SIGINT')
      // on Ctrl+C, which would otherwise close the REPL's readline (setting
      // closed=true) and freeze the session.
      const sigintGuard = () => {};
      process.on('SIGINT', sigintGuard);

      let caughtErr: unknown;
      try {
        await runCommand(tokens);
      } catch (err) {
        caughtErr = err;
        dbg('dispatch:error', { name: err instanceof Error ? err.name : 'unknown', msg: err instanceof Error ? err.message : String(err) });
      }

      process.removeListener('SIGINT', sigintGuard);
      dbg('dispatch:done', { cmd: tokens[0], ...stdinState() });

      // Restore readline's 'keypress' listener and resume stdin.
      if (!closed) {
        for (const fn of savedKeypress) process.stdin.on('keypress', fn);
        process.stdin.resume();
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        rl.resume();
        dbg('stdin keypress restored', stdinState());
      }

      if (caughtErr !== undefined) handleReplError(caughtErr);
      prompt();
    });
  };

  prompt();

  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
  });

  (process.stdout as WriteStreamWithEnd).end = origStdoutEnd;
}

/**
 * Splits a command line string into tokens, respecting quoted strings.
 * Example: `push --password "my secret"` → ['push', '--password', 'my secret']
 *
 * @param line - Raw command line input
 * @returns     Array of argument tokens
 */
function splitArgs(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of line) {
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}
