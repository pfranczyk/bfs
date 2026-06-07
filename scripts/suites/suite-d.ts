import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists, hashDir, verifyShaHashes } from '../smoke-vault.js';

// ─── Suite D — Pull + integrity ───────────────────────────────────────────────

export async function suiteD(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const fileCount = ctx.originalHashes.size;

  tests.push(
    await runTest('D1', 'delete files from sourceDir', async () => {
      const entries = await fs.readdir(ctx.vaultDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.bfs') continue;
        const full = path.join(ctx.vaultDir, entry.name);
        await fs.rm(full, { recursive: true });
      }
      const remaining = await fs.readdir(ctx.vaultDir);
      const nonBfs = remaining.filter((f) => f !== '.bfs');
      assert(nonBfs.length === 0, `expected empty dir, got: ${nonBfs.join(', ')}`);
    }),
  );

  tests.push(
    await runTest('D2', 'bfs pull --force', () => {
      const r = runBfs(['pull', '--force'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('D3', 'SHA-256 of restored files', async () => {
      await verifyShaHashes(ctx.vaultDir, ctx.originalHashes, 'after pull');
    }),
  );

  tests.push(
    await runTest('D4', 'file count after pull', async () => {
      const restored = await hashDir(ctx.vaultDir);
      // Exclude .bfs/ metadata files
      const restoredCount = [...restored.keys()].filter((k) => !k.startsWith('.bfs')).length;
      assert(restoredCount === fileCount, `expected ${fileCount} files, got ${restoredCount}`);
    }),
  );

  // ── Degraded pull (missing shard_0) ───────────────────────────────────────
  // Smoke-vault scheme: 2 data + 1 parity → loss of 1 shard tolerated by RS.
  // Provider p1 holds shard_0 (index 0 → first registered provider).

  tests.push(
    await runTest('D5', 'delete shard_0.bfs.1 — simulate p1 failure', async () => {
      const shardPath = path.join(ctx.provider1Dir, 'smoke-vault', 'shard_0.bfs.1');
      await fs.unlink(shardPath);
      assert(!(await fileExists(shardPath)), `shard_0.bfs.1 still exists after deletion`);
    }),
  );

  tests.push(
    await runTest('D6', 'bfs pull --force (zdegradowany) — exit 0, czysty komunikat warn', () => {
      const r = runBfs(['pull', '--force'], ctx.vaultDir);
      assert(r.status === 0, `expected exit 0 for degraded pull, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const combined = r.stdout + r.stderr;
      assert(/not accessible.*skipping|missing on storage.*skipping|niedost[eę]pny.*pomijam|brakuj[aą] na no[sś]niku.*pomijam/i.test(combined), `expected provider-unreachable or file-missing message in output: ${combined.slice(0, 400)}`);
      assert(!combined.includes('ENOENT'), `output must not contain raw ENOENT chain: ${combined.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('D7', 'SHA-256 of files after degraded pull', async () => {
      await verifyShaHashes(ctx.vaultDir, ctx.originalHashes, 'after degraded pull');
    }),
  );

  return { name: 'Suite D — Pull + integrity', tests };
}
