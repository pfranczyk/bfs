import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// ─── Suite H — --cache-dir flag + bfs config ─────────────────────────────────

/**
 * Tests:
 * - bfs push/pull --help contains --cache-dir
 * - bfs config --help shows description
 * - bfs config --cache-dir <path> sets cache_dir in config.json
 * - bfs config shows the set value
 * - bfs config --cache-dir --reset resets to default (null)
 */
export async function suiteH(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  // Isolated lang env → EN for deterministic assertions
  const hLangDir = path.join(ctx.sourceDir, 'h-lang-config');
  const hEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: hLangDir };
  await fs.mkdir(hLangDir, { recursive: true });

  tests.push(
    await runTest('H1', 'bfs push --help contains --cache-dir', () => {
      const r = runBfs(['push', '--help'], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(
        out.includes('--cache-dir'),
        `--cache-dir missing in bfs push --help: ${out.slice(0, 500)}`,
      );
    }),
  );

  tests.push(
    await runTest('H2', 'bfs pull --help contains --cache-dir', () => {
      const r = runBfs(['pull', '--help'], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(
        out.includes('--cache-dir'),
        `--cache-dir missing in bfs pull --help: ${out.slice(0, 500)}`,
      );
    }),
  );

  tests.push(
    await runTest('H3', 'bfs config --help shows description', () => {
      const r = runBfs(['config', '--help'], ctx.vaultDir, undefined, hEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(
        out.includes('config'),
        `bfs config description missing in: ${out.slice(0, 400)}`,
      );
    }),
  );

  const customCacheDir = path.join(ctx.sourceDir, 'custom-cache');

  tests.push(
    await runTest(
      'H4',
      'bfs config --cache-dir <path> sets value and bfs config shows it',
      async () => {
        const r = runBfs(
          ['config', '--cache-dir', customCacheDir],
          ctx.vaultDir,
          undefined,
          hEnv,
        );
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
        const out = r.stdout + r.stderr;
        assert(
          /updated|zaktualizowane/i.test(out),
          `expected config_updated in: ${out.slice(0, 300)}`,
        );

        // Verify config.json actually contains the value
        const cfg = await readJson<{ cache_dir?: string }>(
          path.join(ctx.vaultDir, '.bfs', 'config.json'),
        );
        assert(
          cfg.cache_dir === customCacheDir,
          `expected cache_dir="${customCacheDir}", got: ${JSON.stringify(cfg.cache_dir)}`,
        );

        // bfs config (no args) shows the set value
        const r2 = runBfs(['config'], ctx.vaultDir, undefined, hEnv);
        assert(r2.status === 0, `exit ${r2.status ?? 'null'}\n${r2.stderr}`);
        const out2 = r2.stdout + r2.stderr;
        assert(
          out2.includes(customCacheDir),
          `expected cache path in bfs config output: ${out2.slice(0, 400)}`,
        );
      },
    ),
  );

  tests.push(
    await runTest(
      'H5',
      'bfs config --cache-dir --reset resets to default',
      async () => {
        const r = runBfs(
          ['config', '--cache-dir', '--reset'],
          ctx.vaultDir,
          undefined,
          hEnv,
        );
        assert(
          r.status === 0,
          `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
        );
        const out = r.stdout + r.stderr;
        assert(
          /reset|default/i.test(out),
          `expected config_reset in: ${out.slice(0, 300)}`,
        );

        // Verify config.json cache_dir is null/absent
        const cfg = await readJson<{ cache_dir?: string | null }>(
          path.join(ctx.vaultDir, '.bfs', 'config.json'),
        );
        assert(
          cfg.cache_dir == null,
          `expected cache_dir null/undefined after reset, got: ${JSON.stringify(cfg.cache_dir)}`,
        );
      },
    ),
  );

  // ── Validation of non-existent paths ────────────────────────────────────────

  tests.push(
    await runTest(
      'H6',
      'bfs config --cache-dir <nonexistent> → rejected with error message',
      async () => {
        // Path with a missing parent — guaranteed to fail validation on both
        // Windows and Linux. Hardcoded "X:\\..." would only fail on Windows;
        // on Linux it's a relative single-segment filename whose parent is
        // the cwd (vaultDir), which exists, so validation would let it pass.
        const badCacheDir = path.join(
          ctx.vaultDir,
          '__no_such_parent__',
          'cache',
        );
        const r = runBfs(
          ['config', '--cache-dir', badCacheDir],
          ctx.vaultDir,
          undefined,
          hEnv,
        );
        const out = r.stdout + r.stderr;
        assert(
          /not exist|nie istnieje/i.test(out),
          `expected non-existent directory error message: ${out.slice(0, 400)}`,
        );
      },
    ),
  );

  tests.push(
    await runTest(
      'H7',
      'bfs push with nonexistent cache_dir → clear error + hint',
      async () => {
        // Set a nonexistent cache_dir directly in config.json. Use a path
        // under vaultDir so missing-parent semantics work on both Windows
        // and Linux (see H6 for why hardcoded "Z:\\..." is unsafe).
        const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
        const cfg = await readJson<Record<string, unknown>>(configPath);
        const origCacheDir = cfg.cache_dir;
        cfg.cache_dir = path.join(ctx.vaultDir, '__no_such_parent__', 'cache');
        await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));

        try {
          const r = runBfs(['push', '--new'], ctx.vaultDir, undefined, hEnv);
          const out = r.stdout + r.stderr;
          assert(r.status !== 0, `expected exit != 0, got: ${r.status}`);
          assert(
            /not exist|nie istnieje/i.test(out),
            `expected non-existent directory error message: ${out.slice(0, 400)}`,
          );
          assert(
            /bfs config/i.test(out),
            `expected bfs config hint in: ${out.slice(0, 400)}`,
          );
        } finally {
          cfg.cache_dir = origCacheDir;
          await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
        }
      },
    ),
  );

  return { name: 'Suite H — --cache-dir + bfs config', tests };
}
