import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { sha256 } from '../smoke-vault.js';

// ─── Suite E — Versioning ────────────────────────────────────────────────────

export async function suiteE(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  // Remember the SHA-256 of the file we're going to modify
  const targetFile = 'hello.txt';
  const originalHash = ctx.originalHashes.get(targetFile);
  assert(
    originalHash !== undefined,
    `${targetFile} missing from originalHashes`,
  );

  tests.push(
    await runTest('E1', `modyfikuj ${targetFile}`, async () => {
      const full = path.join(ctx.vaultDir, targetFile);
      await fs.writeFile(full, 'Modified content for version 2');
    }),
  );

  tests.push(
    await runTest('E2', 'bfs push (v2)', () => {
      const r = runBfs(['push'], ctx.vaultDir);
      assert(
        r.status === 0,
        `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }),
  );

  tests.push(
    await runTest('E3', 'bfs versions (contains 1 and 2)', () => {
      const r = runBfs(['versions'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(
        /\b1\b/.test(out) && /\b2\b/.test(out),
        `expected 1 and 2 in output: ${out.slice(0, 300)}`,
      );
    }),
  );

  tests.push(
    await runTest('E4', 'bfs pull --version 1 --force', () => {
      const r = runBfs(['pull', '--version', '1', '--force'], ctx.vaultDir);
      assert(
        r.status === 0,
        `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
    }),
  );

  tests.push(
    await runTest('E5', `SHA-256 ${targetFile} === v1 (original)`, async () => {
      const full = path.join(ctx.vaultDir, targetFile);
      const buf = await fs.readFile(full);
      const actual = sha256(buf);
      assert(
        actual === originalHash,
        `SHA mismatch: expected v1 hash ${originalHash}, got ${actual}`,
      );
    }),
  );

  return { name: 'Suite E — Versioning', tests };
}
