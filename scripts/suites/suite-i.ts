import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';

// ─── Suite I — Graceful cancellation ─────────────────────────────────────────

export async function suiteI(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  tests.push(
    await runTest(
      'I1',
      'prune without arguments + closed stdin → clean exit',
      () => {
        // Empty stdin simulates no interaction — prompt should exit cleanly
        // via ExitPromptError instead of the ugly "User force closed" in stderr
        const r = runBfs(['prune'], ctx.vaultDir, '');
        const out = r.stdout + r.stderr;
        assert(
          !out.includes('User force closed'),
          `stderr must not contain "User force closed": ${out.slice(0, 400)}`,
        );
      },
    ),
  );

  tests.push(
    await runTest(
      'I2',
      'prune --keep-last 999 --yes → exit 0 (nothing to remove)',
      () => {
        const r = runBfs(
          ['prune', '--keep-last', '999', '--yes'],
          ctx.vaultDir,
        );
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
      },
    ),
  );

  return { name: 'Suite I — Graceful cancellation', tests };
}
