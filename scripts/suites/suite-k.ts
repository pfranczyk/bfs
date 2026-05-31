import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { buildInitArgs, readJson } from '../smoke-vault.js';

// ─── Suite K — Smart compression detection ───────────────────────────────────

export async function suiteK(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-k-${Date.now()}`);
  const vaultDir = path.join(tmpBase, 'vault');
  const p1Dir = path.join(tmpBase, 'p1');
  const p2Dir = path.join(tmpBase, 'p2');
  const p3Dir = path.join(tmpBase, 'p3');

  // ── K0 — init --ci z katalogiem .jpg → compression.enabled=false ─────────

  tests.push(
    await runTest(
      'K0',
      'bfs init --ci w katalogu .jpg → compression.enabled=false',
      async () => {
        await Promise.all(
          [vaultDir, p1Dir, p2Dir, p3Dir].map((d) =>
            fs.mkdir(d, { recursive: true }),
          ),
        );
        // Create fake JPEG files (just .jpg extension, content irrelevant)
        for (let i = 1; i <= 3; i++) {
          await fs.writeFile(
            path.join(vaultDir, `photo${i}.jpg`),
            Buffer.alloc(1024, 0xff),
          );
        }
        const r = runBfs(
          buildInitArgs('smart-vault', [
            { id: 'p1', dir: p1Dir },
            { id: 'p2', dir: p2Dir },
            { id: 'p3', dir: p3Dir },
          ]),
          vaultDir,
        );
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
        const cfg = await readJson<{ compression?: { enabled: boolean } }>(
          path.join(vaultDir, '.bfs', 'config.json'),
        );
        assert(
          cfg.compression?.enabled === false,
          `oczekiwano compression.enabled=false dla katalogu z .jpg, got: ${JSON.stringify(cfg.compression)}`,
        );
      },
    ),
  );

  // ── K1 — bfs config --off compress → compression.enabled=false ───────────

  tests.push(
    await runTest(
      'K1',
      'bfs config --off compress → compression.enabled=false',
      async () => {
        const r = runBfs(['config', '--off', 'compress'], vaultDir);
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );

        const cfg = await readJson<{ compression?: { enabled: boolean } }>(
          path.join(vaultDir, '.bfs', 'config.json'),
        );
        assert(
          cfg.compression?.enabled === false,
          `oczekiwano compression.enabled=false po --off compress, got: ${JSON.stringify(cfg.compression)}`,
        );
      },
    ),
  );

  // ── K2 — bfs config --on compress → compression.enabled=true ────────────

  tests.push(
    await runTest(
      'K2',
      'bfs config --on compress → compression.enabled=true',
      async () => {
        const r = runBfs(['config', '--on', 'compress'], vaultDir);
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );

        const cfg = await readJson<{ compression?: { enabled: boolean } }>(
          path.join(vaultDir, '.bfs', 'config.json'),
        );
        assert(
          cfg.compression?.enabled === true,
          `oczekiwano compression.enabled=true po --on compress, got: ${JSON.stringify(cfg.compression)}`,
        );
      },
    ),
  );

  // ── Cleanup ────────────────────────────────────────────────────────────────

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  return { name: 'Suite K — Smart compression detection', tests };
}
