import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// --- Suite H - --cache-dir flag + bfs config ---------------------------------

/**
 * Tests:
 * - bfs push/pull --help contains --cache-dir
 * - bfs config --help shows description
 * - bfs config --cache-dir <path> sets cache_dir in config.json
 * - bfs config shows the set value
 * - bfs config --cache-dir --reset resets to default (null)
 * - bfs config with temp_dir unset names the system temp as the default (H8)
 * - bfs push / bfs pull --temp-dir <file> refuse with the path and the
 *   `bfs config --temp-dir` hint, no raw errno (H9, H10)
 * - bfs config --temp-dir / --cache-dir <file> refuse the same leaf its own
 *   readers reject, with a non-zero exit and the hint (H11, H12)
 * - bfs push / bfs pull name the cache directory and `bfs config --cache-dir`
 *   when the blob cannot be written there, keeping the OS reason (H13, H14)
 */
export async function suiteH(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  // Isolated lang env -> EN for deterministic assertions
  const hLangDir = path.join(ctx.sourceDir, 'h-lang-config');
  const hEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: hLangDir };
  await fs.mkdir(hLangDir, { recursive: true });

  tests.push(
    await runTest('H1', 'bfs push --help contains --cache-dir', () => {
      const r = runBfs(['push', '--help'], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cache-dir'), `--cache-dir missing in bfs push --help: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('H2', 'bfs pull --help contains --cache-dir', () => {
      const r = runBfs(['pull', '--help'], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cache-dir'), `--cache-dir missing in bfs pull --help: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('H3', 'bfs config --help shows description', () => {
      const r = runBfs(['config', '--help'], ctx.vaultDir, undefined, hEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('config'), `bfs config description missing in: ${out.slice(0, 400)}`);
    }),
  );

  const customCacheDir = path.join(ctx.sourceDir, 'custom-cache');

  tests.push(
    await runTest('H4', 'bfs config --cache-dir <path> sets value and bfs config shows it', async () => {
      const r = runBfs(['config', '--cache-dir', customCacheDir], ctx.vaultDir, undefined, hEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/updated|zaktualizowane/i.test(out), `expected config_updated in: ${out.slice(0, 300)}`);

      // Verify config.json actually contains the value
      const cfg = await readJson<{ cache_dir?: string }>(path.join(ctx.vaultDir, '.bfs', 'config.json'));
      assert(cfg.cache_dir === customCacheDir, `expected cache_dir="${customCacheDir}", got: ${JSON.stringify(cfg.cache_dir)}`);

      // bfs config (no args) shows the set value
      const r2 = runBfs(['config'], ctx.vaultDir, undefined, hEnv);
      assert(r2.status === 0, `exit ${r2.status ?? 'null'}\n${r2.stderr}`);
      const out2 = r2.stdout + r2.stderr;
      assert(out2.includes(customCacheDir), `expected cache path in bfs config output: ${out2.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('H5', 'bfs config --cache-dir --reset resets to default', async () => {
      const r = runBfs(['config', '--cache-dir', '--reset'], ctx.vaultDir, undefined, hEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/reset|default/i.test(out), `expected config_reset in: ${out.slice(0, 300)}`);

      // Verify config.json cache_dir is null/absent
      const cfg = await readJson<{ cache_dir?: string | null }>(path.join(ctx.vaultDir, '.bfs', 'config.json'));
      assert(cfg.cache_dir == null, `expected cache_dir null/undefined after reset, got: ${JSON.stringify(cfg.cache_dir)}`);
    }),
  );

  // -- Validation of non-existent paths ----------------------------------------

  tests.push(
    await runTest('H6', 'bfs config --cache-dir <nonexistent> -> rejected with error message', async () => {
      // Path with a missing parent - guaranteed to fail validation on both
      // Windows and Linux. Hardcoded "X:\\..." would only fail on Windows;
      // on Linux it's a relative single-segment filename whose parent is
      // the cwd (vaultDir), which exists, so validation would let it pass.
      const badCacheDir = path.join(ctx.vaultDir, '__no_such_parent__', 'cache');
      const r = runBfs(['config', '--cache-dir', badCacheDir], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(/not exist|nie istnieje/i.test(out), `expected non-existent directory error message: ${out.slice(0, 400)}`);
      // A refusal that exits 0 cannot be told apart from a stored value by
      // anything driving `bfs config` from a script.
      assert(r.status !== 0, `expected exit != 0 for a refused setting, got: ${r.status}`);
    }),
  );

  tests.push(
    await runTest('H7', 'bfs push with nonexistent cache_dir -> clear error + hint', async () => {
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
        assert(/not exist|nie istnieje/i.test(out), `expected non-existent directory error message: ${out.slice(0, 400)}`);
        assert(/bfs config/i.test(out), `expected bfs config hint in: ${out.slice(0, 400)}`);
      } finally {
        cfg.cache_dir = origCacheDir;
        await fs.writeFile(configPath, JSON.stringify(cfg, null, 2));
      }
    }),
  );

  tests.push(
    await runTest('H8', 'bfs config with temp_dir unset names the system temp as the default', async () => {
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const cfg = await readJson<Record<string, unknown>>(configPath);
      assert(cfg.temp_dir === undefined || cfg.temp_dir === null, `fixture must have temp_dir unset, got: ${JSON.stringify(cfg.temp_dir)}`);
      const r = runBfs(['config'], ctx.vaultDir, undefined, hEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/temp-dir:\s+\(default: system temp\)/.test(out), `expected temp-dir default line in bfs config output: ${out.slice(0, 400)}`);
    }),
  );

  // A temp directory that cannot take the scratch files is a local condition
  // with a one-command fix, and the error has to say so: name the path that
  // refused and point at `bfs config --temp-dir`. A path that exists as a file
  // is the portable way to make the scratch unusable from outside the process
  // (a full volume cannot be staged on every platform): its parent exists, so
  // the directory check passes, and creating the scratch under it fails.
  const tempDirFile = path.join(ctx.sourceDir, 'temp-dir-is-a-file');

  tests.push(
    await runTest('H9', 'bfs push --temp-dir <file> -> names the path and `bfs config --temp-dir`, no raw errno', async () => {
      await fs.writeFile(tempDirFile, 'not a directory');
      const r = runBfs(['push', '--new', '--temp-dir', tempDirFile], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected exit != 0, got: ${r.status}`);
      assert(out.includes(tempDirFile), `expected the refused temp path in: ${out.slice(0, 400)}`);
      assert(/bfs config --temp-dir/.test(out), `expected the temp-dir hint in: ${out.slice(0, 400)}`);
      assert(!/^\s*at .+:\d+:\d+/m.test(out), `expected no stack trace in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('H10', 'bfs pull --temp-dir <file> -> names the path and `bfs config --temp-dir`, no raw errno', async () => {
      const r = runBfs(['pull', '--force', '--temp-dir', tempDirFile], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected exit != 0, got: ${r.status}`);
      assert(out.includes(tempDirFile), `expected the refused temp path in: ${out.slice(0, 400)}`);
      assert(/bfs config --temp-dir/.test(out), `expected the temp-dir hint in: ${out.slice(0, 400)}`);
      assert(!/^\s*at .+:\d+:\d+/m.test(out), `expected no stack trace in: ${out.slice(0, 400)}`);
    }),
  );

  // `bfs config` is the only writer of these two settings and push/pull are
  // the only readers. The readers refuse a path whose leaf exists and is not a
  // directory; the writer must refuse the same path, or it stores a value that
  // works until the next push and then sends the operator back here (H11, H12).
  const configLeafFile = path.join(ctx.sourceDir, 'config-dir-is-a-file');

  tests.push(
    await runTest('H11', 'bfs config --temp-dir <file> -> refused with the path, the reason and the hint', async () => {
      await fs.writeFile(configLeafFile, 'not a directory');
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const before = await readJson<Record<string, unknown>>(configPath);
      const r = runBfs(['config', '--temp-dir', configLeafFile], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected exit != 0, got: ${r.status}\n${out.slice(0, 400)}`);
      assert(/not a directory|nie jest katalogiem/i.test(out), `expected a not-a-directory refusal in: ${out.slice(0, 400)}`);
      assert(/bfs config --temp-dir/.test(out), `expected the temp-dir hint in: ${out.slice(0, 400)}`);
      const after = await readJson<Record<string, unknown>>(configPath);
      assert(after.temp_dir === before.temp_dir, `a refused path must not reach config.json, got: ${JSON.stringify(after.temp_dir)}`);
    }),
  );

  tests.push(
    await runTest('H12', 'bfs config --cache-dir <file> -> refused with the path, the reason and the hint', async () => {
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const before = await readJson<Record<string, unknown>>(configPath);
      const r = runBfs(['config', '--cache-dir', configLeafFile], ctx.vaultDir, undefined, hEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected exit != 0, got: ${r.status}\n${out.slice(0, 400)}`);
      assert(/not a directory|nie jest katalogiem/i.test(out), `expected a not-a-directory refusal in: ${out.slice(0, 400)}`);
      assert(/bfs config --cache-dir/.test(out), `expected the cache-dir hint in: ${out.slice(0, 400)}`);
      const after = await readJson<Record<string, unknown>>(configPath);
      assert(after.cache_dir === before.cache_dir, `a refused path must not reach config.json, got: ${JSON.stringify(after.cache_dir)}`);
    }),
  );

  // The backup's own volume is the second one a run can fill, and it is not the
  // temp: the packed blob (push) and the restored blob (pull) are written to
  // the cache directory. Both name that directory and the one command that
  // moves it, around the system's own reason, so the operator can tell which of
  // the two disks ran out (H13, H14). The blob file is replaced by a directory
  // of the same name - portable, and the open fails the way a full or read-only
  // volume does.
  const blockedCache = path.join(ctx.sourceDir, 'blocked-cache');

  tests.push(
    await runTest('H13', 'bfs push with a cache dir that refuses the blob -> names it and `bfs config --cache-dir`', async () => {
      await fs.mkdir(path.join(blockedCache, 'push.blob.pending'), { recursive: true });
      try {
        // --yes: earlier suites left the working directory on an older version
        // than the media hold, and the version-switch gate would otherwise stop
        // this push before it ever reaches the cache.
        const r = runBfs(['push', '--new', '--yes', '--cache-dir', blockedCache], ctx.vaultDir, undefined, hEnv);
        const out = r.stdout + r.stderr;
        assert(r.status !== 0, `expected exit != 0, got: ${r.status}`);
        assert(out.includes(blockedCache), `expected the refused cache path in: ${out.slice(0, 400)}`);
        assert(/bfs config --cache-dir/.test(out), `expected the cache-dir hint in: ${out.slice(0, 400)}`);
        assert(/EISDIR/.test(out), `the OS reason must survive, as it does for the temp volume: ${out.slice(0, 400)}`);
        assert(!/^\s*at .+:\d+:\d+/m.test(out), `expected no stack trace in: ${out.slice(0, 400)}`);
      } finally {
        // The pack fails after the push lock is taken; leaving it behind would
        // fail every later suite on this vault.
        await fs.rm(path.join(ctx.vaultDir, '.bfs', 'push.lock'), { force: true });
        await fs.rm(path.join(blockedCache, 'push.blob.pending'), { recursive: true, force: true });
      }
    }),
  );

  tests.push(
    await runTest('H14', 'bfs pull with a cache dir that refuses the blob -> names it and `bfs config --cache-dir`', async () => {
      await fs.mkdir(path.join(blockedCache, 'pull.blob.pending'), { recursive: true });
      try {
        const r = runBfs(['pull', '--force', '--yes', '--cache-dir', blockedCache], ctx.vaultDir, undefined, hEnv);
        const out = r.stdout + r.stderr;
        assert(r.status !== 0, `expected exit != 0, got: ${r.status}`);
        assert(out.includes(blockedCache), `expected the refused cache path in: ${out.slice(0, 400)}`);
        assert(/bfs config --cache-dir/.test(out), `expected the cache-dir hint in: ${out.slice(0, 400)}`);
        assert(/EISDIR/.test(out), `the OS reason must survive, as it does for the temp volume: ${out.slice(0, 400)}`);
        assert(!/^\s*at .+:\d+:\d+/m.test(out), `expected no stack trace in: ${out.slice(0, 400)}`);
      } finally {
        await fs.rm(path.join(blockedCache, 'pull.blob.pending'), { recursive: true, force: true });
      }
    }),
  );

  return { name: 'Suite H - --cache-dir + bfs config', tests };
}
