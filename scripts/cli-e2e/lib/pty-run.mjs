// PTY driver for cli-e2e — runs the real `bfs` CLI inside a pseudo-terminal so
// inquirer sees a true TTY (process.stdin.isTTY === true) and renders N
// sequential interactive prompts exactly as a human operator would see them.
// A piped stdin only feeds the FIRST inquirer prompt per process (inquirer
// closes stdin after the first resolve), so multi-prompt flows such as
// `bfs recovery` on a stripped vault cannot be driven through `run_bfs`'s
// </dev/null path — this driver exists for that gap.
//
// Invocation (from run_bfs_pty):
//   node pty-run.mjs <bfs-entry> <vault-cwd> <bfs-args...>
//   env PTY_ANSWERS  = JSON [{ "anchor": "<substring>", "value": "<secret>" }, …]
//                      answers are fed in order: the i-th value is written + Enter
//                      the first time its anchor appears in the terminal output.
//   env PTY_TIMEOUT  = max ms before the child is killed (default 90000).
//
// All terminal output is mirrored to stdout so the bash scenario can assert on
// it; secrets echo back masked (inquirer's '*'), never in plaintext. The driver
// exits with the child's exit code.

import path from 'node:path';
import process from 'node:process';
import { spawn } from '@lydell/node-pty';

const [entry, vaultCwd, ...bfsArgs] = process.argv.slice(2);
if (!entry || !vaultCwd) {
  process.stderr.write('pty-run: usage: node pty-run.mjs <bfs-entry> <vault-cwd> <bfs-args...>\n');
  process.exit(2);
}

const answers = JSON.parse(process.env.PTY_ANSWERS ?? '[]');
const timeoutMs = Number(process.env.PTY_TIMEOUT ?? 90000);
const repoRoot = path.dirname(path.dirname(entry));

const child = spawn(process.execPath, ['--import', 'tsx', entry, '--cwd', vaultCwd, ...bfsArgs], { name: 'xterm-color', cols: 100, rows: 40, cwd: repoRoot, env: process.env });

let full = '';
let searchFrom = 0;
let idx = 0;

const feedReadyAnswers = () => {
  while (idx < answers.length) {
    const { anchor, value } = answers[idx];
    const pos = full.indexOf(anchor, searchFrom);
    if (pos === -1) return;
    child.write(`${value}\r`);
    searchFrom = pos + anchor.length;
    idx += 1;
  }
};

const killTimer = setTimeout(() => {
  process.stdout.write(`\nPTY_RUN: TIMEOUT after ${timeoutMs}ms (prompts fed: ${idx}/${answers.length})\n`);
  try {
    child.kill();
  } catch {
    // already gone
  }
  process.exit(124);
}, timeoutMs);

child.onData((data) => {
  full += data;
  process.stdout.write(data);
  feedReadyAnswers();
});

child.onExit(({ exitCode }) => {
  clearTimeout(killTimer);
  const code = exitCode ?? 0;
  process.stdout.write(`\nPTY_EXIT=${code} PROMPTS_FED=${idx}/${answers.length}\n`);
  process.exit(code);
});
