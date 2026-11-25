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
 * - bfs config --push-mode stores the mode, bfs config shows it, an unknown
 *   mode is refused with the init wording and a non-zero exit (H15)
 * - bfs config --on/--off next to other settings applies every one of them and
 *   lists what was set; one invalid value refuses the whole command (H16)
 * - bfs config / bfs push --max-ram refuse anything but a whole number above
 *   zero with exit 1, leaving config.json untouched (H17)
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
      assert(/reset|default/i.test(out), `expected the default value in: ${out.slice(0, 300)}`);

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

  tests.push(
    await runTest('H15', 'bfs config --push-mode <mode> stores it, bfs config shows it, an unknown mode is refused', async () => {
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const original = await readJson<Record<string, unknown>>(configPath);
      assert(original.push_mode !== 'overwrite', `fixture must not already record overwrite, got: ${JSON.stringify(original.push_mode)}`);
      try {
        const r = runBfs(['config', '--push-mode', 'overwrite'], ctx.vaultDir, undefined, hEnv);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const cfg = await readJson<{ push_mode?: string }>(configPath);
        assert(cfg.push_mode === 'overwrite', `expected push_mode="overwrite", got: ${JSON.stringify(cfg.push_mode)}`);

        const shown = runBfs(['config'], ctx.vaultDir, undefined, hEnv);
        const shownOut = shown.stdout + shown.stderr;
        assert(/push-mode:\s+overwrite/.test(shownOut), `expected push-mode line in bfs config output: ${shownOut.slice(0, 400)}`);

        const bad = runBfs(['config', '--push-mode', 'sometimes'], ctx.vaultDir, undefined, hEnv);
        const badOut = bad.stdout + bad.stderr;
        assert(bad.status !== 0, `expected exit != 0 for an unknown mode, got: ${bad.status}`);
        assert(/Invalid --push-mode: "sometimes"/.test(badOut), `expected the init wording in: ${badOut.slice(0, 400)}`);
        const after = await readJson<{ push_mode?: string }>(configPath);
        assert(after.push_mode === 'overwrite', `a refused mode must leave config.json alone, got: ${JSON.stringify(after.push_mode)}`);
      } finally {
        // The vault is shared by the suites: leave it as it was found.
        await fs.writeFile(configPath, JSON.stringify(original, null, 2));
      }
    }),
  );

  tests.push(
    await runTest('H16', 'bfs config --on/--off with other settings applies all of them and lists them; one bad value refuses all', async () => {
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const original = await readJson<{ push_mode?: string; compression?: { enabled?: boolean } }>(configPath);
      assert(original.push_mode !== 'overwrite', `fixture must not already record overwrite, got: ${JSON.stringify(original.push_mode)}`);
      // Flip compression away from whatever the fixture holds, so the write is observable either way.
      const wasCompressed = original.compression?.enabled === true;
      const toggle = wasCompressed ? '--off' : '--on';
      const tempDir = path.join(hLangDir, 'h16-temp');
      try {
        const r = runBfs(['config', toggle, 'compress', '--push-mode', 'overwrite', '--temp-dir', tempDir], ctx.vaultDir, undefined, hEnv);
        const out = r.stdout + r.stderr;
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const cfg = await readJson<{ push_mode?: string; temp_dir?: string; compression?: { enabled?: boolean } }>(configPath);
        assert(cfg.push_mode === 'overwrite', `push mode typed next to ${toggle} was dropped, got: ${JSON.stringify(cfg.push_mode)}`);
        assert(cfg.temp_dir === tempDir, `temp dir typed next to ${toggle} was dropped, got: ${JSON.stringify(cfg.temp_dir)}`);
        assert(cfg.compression?.enabled === !wasCompressed, `compression not switched, got: ${JSON.stringify(cfg.compression)}`);
        assert(out.includes('Settings updated:'), `expected the list heading in: ${out.slice(0, 500)}`);
        assert(/push-mode:\s+overwrite/.test(out), `expected the push-mode line in: ${out.slice(0, 500)}`);
        assert(out.includes(`temp-dir:`) && out.includes(tempDir), `expected the temp-dir line in: ${out.slice(0, 500)}`);
        assert(new RegExp(`compression:\\s+${wasCompressed ? 'disabled' : 'enabled'}`).test(out), `expected the compression line in: ${out.slice(0, 500)}`);

        const before = await fs.readFile(configPath, 'utf8');
        const bad = runBfs(['config', wasCompressed ? '--on' : '--off', 'compress', '--push-mode', 'OVERWRITE'], ctx.vaultDir, undefined, hEnv);
        const badOut = bad.stdout + bad.stderr;
        assert(bad.status !== 0, `expected exit != 0 when one value is invalid, got: ${bad.status}\n${badOut.slice(0, 400)}`);
        assert(/Invalid --push-mode: "OVERWRITE"/.test(badOut), `expected the init wording in: ${badOut.slice(0, 400)}`);
        const after = await fs.readFile(configPath, 'utf8');
        assert(after === before, 'a refused command must leave config.json untouched - compression included');
      } finally {
        // The vault is shared by the suites: leave it as it was found.
        await fs.writeFile(configPath, JSON.stringify(original, null, 2));
      }
    }),
  );

  tests.push(
    await runTest('H17', 'bfs config / push --max-ram refuse anything but a whole number above zero and leave config.json alone', async () => {
      const configPath = path.join(ctx.vaultDir, '.bfs', 'config.json');
      const original = await fs.readFile(configPath, 'utf8');
      try {
        for (const value of ['abc', '512abc', '-5', '0']) {
          const bad = runBfs(['config', '--max-ram', value], ctx.vaultDir, undefined, hEnv);
          const badOut = bad.stdout + bad.stderr;
          assert(bad.status === 1, `config --max-ram ${value}: expected exit 1, got: ${bad.status}\n${badOut.slice(0, 400)}`);
          assert(badOut.includes(`--max-ram must be an integer >= 1 (MB), got "${value}".`), `config --max-ram ${value}: expected the refusal in: ${badOut.slice(0, 400)}`);
          assert(!/NaN MB/.test(badOut), `config --max-ram ${value}: a refused value must not be listed: ${badOut.slice(0, 400)}`);
          const after = await fs.readFile(configPath, 'utf8');
          assert(after === original, `config --max-ram ${value}: a refused value must leave config.json untouched`);

          const push = runBfs(['push', '--max-ram', value], ctx.vaultDir, undefined, hEnv);
          const pushOut = push.stdout + push.stderr;
          assert(push.status === 1, `push --max-ram ${value}: expected exit 1, got: ${push.status}\n${pushOut.slice(0, 400)}`);
          assert(pushOut.includes(`--max-ram must be an integer >= 1 (MB), got "${value}".`), `push --max-ram ${value}: expected the refusal in: ${pushOut.slice(0, 400)}`);
        }

        // A/B control: a valid value is still stored and listed.
        const ok = runBfs(['config', '--max-ram', '512'], ctx.vaultDir, undefined, hEnv);
        const okOut = ok.stdout + ok.stderr;
        assert(ok.status === 0, `config --max-ram 512: exit ${ok.status ?? 'null'}\n${okOut.slice(0, 400)}`);
        const cfg = await readJson<{ max_ram_mb?: unknown }>(configPath);
        assert(cfg.max_ram_mb === 512, `expected max_ram_mb=512, got: ${JSON.stringify(cfg.max_ram_mb)}`);
        assert(/max-ram:\s+512 MB/.test(okOut), `expected the max-ram line in: ${okOut.slice(0, 400)}`);
      } finally {
        // The vault is shared by the suites: leave it as it was found.
        await fs.writeFile(configPath, original);
      }
    }),
  );

  return { name: 'Suite H - --cache-dir + bfs config', tests };
}
