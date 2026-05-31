import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';

// ─── Suite C — Push + odczyt ─────────────────────────────────────────────────

export async function suiteC(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  tests.push(
    await runTest('C1', 'bfs push', () => {
      const r = runBfs(['push'], ctx.vaultDir);
      assert(
        r.status === 0,
        `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }),
  );

  tests.push(
    await runTest('C2', 'shards na dysku (v1)', async () => {
      for (const provDir of [
        ctx.provider1Dir,
        ctx.provider2Dir,
        ctx.provider3Dir,
      ]) {
        const vaultSubdir = path.join(provDir, 'smoke-vault');
        const files = await fs.readdir(vaultSubdir).catch(() => [] as string[]);
        const shards = files.filter((f) => /shard_\d+\.bfs\.1$/.test(f));
        assert(
          shards.length === 1,
          `${provDir}: expected 1 shard v1, got ${shards.length} (files: ${files.join(', ')})`,
        );
      }
    }),
  );

  tests.push(
    await runTest('C3', 'bfs status', () => {
      const r = runBfs(['status'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(
        /v1|version.?1/i.test(out),
        `expected v1 in output: ${out.slice(0, 300)}`,
      );
    }),
  );

  tests.push(
    await runTest('C4', 'bfs versions', () => {
      const r = runBfs(['versions'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/\b1\b/.test(out), `expected "1" in output: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('C5', 'bfs verify', () => {
      const r = runBfs(['verify'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(
        /healthy|zdrow/i.test(out),
        `expected healthy/zdrowa in output: ${out.slice(0, 300)}`,
      );
    }),
  );

  tests.push(
    await runTest('C6', 'bfs provider list', () => {
      const r = runBfs(['provider', 'list'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(
        out.includes('p1') && out.includes('p2') && out.includes('p3'),
        `expected provider names p1/p2/p3 in output: ${out.slice(0, 300)}`,
      );
    }),
  );

  return { name: 'Suite C — Push + odczyt', tests };
}
