import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { bin, PROJECT_ROOT } from './smoke-config.js';
import type { SpawnResult, SuiteResult, TestResult } from './smoke-types.js';

/**
 * Runs a bfs command with the given arguments in the given directory.
 *
 * @param bfsArgs      - CLI arguments, e.g. ['--help']
 * @param cwd          - Vault directory
 * @param stdin        - Optional stdin input (piped, for non-interactive calls)
 * @param env          - Optional environment variables (override process.env in the subprocess)
 * @param withCwdFlag  - When true, spawn uses PROJECT_ROOT and `--cwd <cwd>` is
 *                       prepended to argv. Lets you distinguish the bug "BFS
 *                       reads from process.cwd instead of --cwd" from the correct flow.
 * @returns       Result: status, stdout, stderr
 */
export function runBfs(bfsArgs: string[], cwd: string, stdin?: string, env?: NodeJS.ProcessEnv, withCwdFlag?: boolean): SpawnResult {
  const isWin = process.platform === 'win32';
  const finalArgs = withCwdFlag === true ? ['--cwd', cwd, ...bfsArgs] : bfsArgs;
  // When the flag drives rootDir, spawn from a vault-unrelated cwd so any
  // accidental process.cwd() use lands somewhere harmless and observable.
  const spawnCwd = withCwdFlag === true ? PROJECT_ROOT : cwd;

  let exe: string;
  let spawnArgs: string[];

  if (bin.endsWith('.ts')) {
    // TS file: run via tsx (on Windows tsx.cmd through cmd /c)
    const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
    if (isWin) {
      exe = 'cmd.exe';
      spawnArgs = ['/c', tsxBin, bin, ...finalArgs];
    } else {
      exe = tsxBin;
      spawnArgs = [bin, ...finalArgs];
    }
  } else {
    // JS file: invoke node directly — stdin piping works correctly without cmd /c
    exe = process.execPath;
    spawnArgs = [bin, ...finalArgs];
  }

  const result = spawnSync(exe, spawnArgs, { cwd: spawnCwd, encoding: 'utf8', timeout: 30_000, input: stdin, ...(env !== undefined ? { env } : {}) });

  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Runs a single test and measures execution time.
 *
 * @param id          - Test identifier (e.g. "A1")
 * @param description - Description of the command / action being tested
 * @param fn          - Test function — throws on failure or returns normally
 * @returns           Test result
 */
export async function runTest(id: string, description: string, fn: () => Promise<void> | void): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { id, description, passed: true, ms: Date.now() - start };
  } catch (err) {
    return { id, description, passed: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - start };
  }
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * Creates a skipped test result (counts as neither pass nor fail).
 *
 * @param id          - Test identifier (e.g. "L1")
 * @param description - Human-readable description
 * @param reason      - Why the test was skipped
 * @returns TestResult with skipped=true
 */
export function skipTest(id: string, description: string, reason: string): TestResult {
  return { id, description, passed: true, skipped: true, error: reason, ms: 0 };
}

/**
 * Prints a test suite's results and returns failure/skipped counts.
 *
 * @param suite - Suite to print
 * @returns Object with failure and skipped counts
 */
export function printSuite(suite: SuiteResult): { failures: number; skipped: number } {
  console.log(`\n[SMOKE] ${suite.name}`);
  let failures = 0;
  let skipped = 0;
  for (const t of suite.tests) {
    const icon = t.skipped ? '⏭' : t.passed ? '✓' : '✗';
    const idPad = t.id.padEnd(3);
    const descPad = t.description.padEnd(36);
    const ms = `(${t.ms}ms)`;
    console.log(`  ${icon} ${idPad} ${descPad} ${ms}`);
    if (t.skipped) {
      if (t.error) console.log(`      skip: ${t.error}`);
      skipped++;
    } else if (!t.passed && t.error) {
      console.log(`      ${t.error}`);
      failures++;
    }
  }
  return { failures, skipped };
}

/**
 * Denies read access to a file for the current user.
 * Works without root/admin — a file's owner can always modify its ACL/mode.
 */
export function denyRead(filePath: string): void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? 'Everyone';
    spawnSync('icacls', [filePath, '/deny', `${user}:(R,RX)`], { stdio: 'ignore' });
  } else {
    spawnSync('chmod', ['000', filePath], { stdio: 'ignore' });
  }
}

/**
 * Restores read access to a file after a previous denyRead() call.
 */
export function restoreRead(filePath: string): void {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? 'Everyone';
    spawnSync('icacls', [filePath, '/remove:d', user], { stdio: 'ignore' });
  } else {
    spawnSync('chmod', ['644', filePath], { stdio: 'ignore' });
  }
}
