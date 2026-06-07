import fs from 'node:fs/promises';
import path from 'node:path';
// Side-effect: registers "local" type in ProviderRegistry.
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init } from '../../src/vault/vault-manager.js';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists, readJson } from '../smoke-vault.js';

// ─── Suite N — push partial-commit + lockfile pattern (PR1) ─────────────────
//
// Verifies the PR1 user-facing surface: partial-commit push semantics
// (Degraded/Damaged exit codes + messages), push.lock + repair.lock
// cleanup by `bfs clear`, --cache validation, and the bfs status scheme
// warning. Uses an isolated vault to avoid interfering with other suites.

export async function suiteN(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const nTmpDir = path.join(ctx.sourceDir, 'n-partial');
  const nVaultDir = path.join(nTmpDir, 'vault');
  const nP1Dir = path.join(nTmpDir, 'p1');
  const nP2Dir = path.join(nTmpDir, 'p2');
  const nP3Dir = path.join(nTmpDir, 'p3');
  // Isolated XDG_CONFIG_HOME → no global settings → default lang 'en'.
  const nLangDir = path.join(nTmpDir, 'lang-config');
  const nEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: nLangDir };

  const pushLockFile = path.join(nVaultDir, '.bfs', 'push.lock');
  const repairLockFile = path.join(nVaultDir, '.bfs', 'repair.lock');
  const pushBlobPending = path.join(nVaultDir, '.bfs', 'cache', 'push.blob.pending');
  const pullBlobPending = path.join(nVaultDir, '.bfs', 'cache', 'pull.blob.pending');

  // ── N0: Setup isolated vault 2/1 with 3 local providers ───────────────────

  tests.push(
    await runTest('N0', 'setup: vault N (partial-commit)', async () => {
      await fs.mkdir(nVaultDir, { recursive: true });
      await fs.mkdir(nP1Dir, { recursive: true });
      await fs.mkdir(nP2Dir, { recursive: true });
      await fs.mkdir(nP3Dir, { recursive: true });
      await fs.mkdir(nLangDir, { recursive: true });

      await fs.writeFile(path.join(nVaultDir, 'hello.txt'), 'Hello, partial commit!');

      const { io } = createMockProviderIO();
      const providers: ProviderConfig[] = [
        { id: 'np1', type: 'local', adapterPackage: null, config: { path: nP1Dir } },
        { id: 'np2', type: 'local', adapterPackage: null, config: { path: nP2Dir } },
        { id: 'np3', type: 'local', adapterPackage: null, config: { path: nP3Dir } },
      ];
      await init(nVaultDir, { vault_name: 'n-vault', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, push_mode: PushMode.NewVersion, providers, io });
    }),
  );

  // ── N1: bfs push happy → healthy, lock + cache cleaned ────────────────────

  tests.push(
    await runTest('N1', 'bfs push happy — healthy + no leftover lock/cache', async () => {
      const r = runBfs(['push'], nVaultDir, undefined, nEnv);
      assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/healthy.*3 of 3 uploaded|zdrowa.*3 z 3 wgranych/i.test(out), `expected healthy completion: ${out.slice(0, 400)}`);
      assert(!(await fileExists(pushLockFile)), 'push.lock should be removed on healthy push');
      assert(!(await fileExists(pushBlobPending)), 'push.blob.pending should be removed on healthy push');
    }),
  );

  // ── N2: bfs push partial — break p3 dir → degraded ────────────────────────

  tests.push(
    await runTest('N2', 'bfs push partial — exit != 0, degraded manifest, lock retained', async () => {
      // Break provider p3: replace its directory with a regular file so
      // LocalFS `mkdir(vaultDir, recursive: true)` inside upload() fails
      // with ENOTDIR. Push then commits 2/3 shards as Degraded.
      await fs.rm(nP3Dir, { recursive: true, force: true });
      await fs.writeFile(nP3Dir, 'sabotage');

      try {
        const r = runBfs(['push'], nVaultDir, undefined, nEnv);
        assert(r.status !== 0, `expected non-zero exit for degraded push, got ${r.status}`);
        const out = r.stdout + r.stderr;
        assert(/degraded|zdegradowan/i.test(out), `expected degraded message: ${out.slice(0, 400)}`);
        assert(/2 of 3 uploaded|2 z 3 wgranych/i.test(out), `expected "2 of 3 uploaded": ${out.slice(0, 400)}`);

        const manifestPath = path.join(nVaultDir, '.bfs', 'manifests', 'v002.json');
        const manifest = await readJson<{ shards: unknown[]; health: string }>(manifestPath);
        assert(manifest.shards.length === 2, `expected manifest.shards.length=2, got ${manifest.shards.length}`);
        assert(manifest.health === 'degraded', `expected manifest.health=degraded, got ${manifest.health}`);

        assert(await fileExists(pushLockFile), 'push.lock should be retained after degraded push');
        const lock = await readJson<{ uploaded: unknown[]; failed: unknown[] }>(pushLockFile);
        assert(lock.failed.length === 1, `expected lock.failed.length=1, got ${lock.failed.length}`);
        assert(lock.uploaded.length === 2, `expected lock.uploaded.length=2, got ${lock.uploaded.length}`);
        assert(await fileExists(pushBlobPending), 'push.blob.pending should be retained for --cache retry');
      } finally {
        // Restore p3 as directory so subsequent tests are deterministic.
        await fs.unlink(nP3Dir).catch(() => {});
        await fs.mkdir(nP3Dir, { recursive: true });
      }
    }),
  );

  // ── N3: bfs clear — removes all 4 leftover files ──────────────────────────

  tests.push(
    await runTest('N3', 'bfs clear — removes push.lock + repair.lock + both blob.pending', async () => {
      // Pre-condition: N2 left push.lock + push.blob.pending in place.
      // Manually create repair.lock + pull.blob.pending so this test
      // covers all four cleanup targets in one shot.
      await fs.writeFile(
        repairLockFile,
        JSON.stringify({ format_version: 1, operation: 'repair', version_range: 'latest', pid: 99999, command: 'bfs repair', started_at: new Date(0).toISOString(), succeeded_pairs: [], failed_pairs: [], failed_shards: [] }),
      );
      await fs.writeFile(pullBlobPending, 'dummy pull');

      const r = runBfs(['clear'], nVaultDir, undefined, nEnv);
      assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

      assert(!(await fileExists(pushLockFile)), 'push.lock not removed');
      assert(!(await fileExists(repairLockFile)), 'repair.lock not removed');
      assert(!(await fileExists(pushBlobPending)), 'push.blob.pending not removed');
      assert(!(await fileExists(pullBlobPending)), 'pull.blob.pending not removed');
    }),
  );

  // ── N4: bfs push --cache without push.lock → PushCacheNoLockError ─────────

  tests.push(
    await runTest('N4', 'bfs push --cache without push.lock — exit != 0, missing files reported', async () => {
      // Pre-condition: N3 cleared everything; lock + blob absent.
      const r = runBfs(['push', '--cache'], nVaultDir, undefined, nEnv);
      assert(r.status !== 0, `expected non-zero exit, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/missing|brakuje/i.test(out), `expected "missing" hint: ${out.slice(0, 400)}`);
    }),
  );

  // ── N5: bfs status warn for scheme below minimum (3/0) ────────────────────

  tests.push(
    await runTest('N5', 'bfs status — push-disabled warn when scheme is 3/0', async () => {
      // Manually downgrade the scheme below minimum to trigger the warn.
      // `status()` is a read-only command and does not call assertSchemeValid,
      // so the command still succeeds — only the warn line is emitted.
      const cfgPath = path.join(nVaultDir, '.bfs', 'config.json');
      const cfg = await readJson<VaultConfig>(cfgPath);
      cfg.scheme = { data_shards: 3, parity_shards: 0 };
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

      const r = runBfs(['status'], nVaultDir, undefined, nEnv);
      assert(r.status === 0, `expected exit 0 for status, got ${r.status}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/push disabled|push wyłączony/i.test(out), `expected push-disabled warn: ${out.slice(0, 400)}`);
      assert(/3\/0/.test(out), `expected "3/0" in output: ${out.slice(0, 400)}`);
    }),
  );

  // ── N6 + N7 prep: fresh mini-vault driven by --cwd flag only ──────────────
  // Separate from the N0-N5 vault because N5 mutates scheme to 3/0. These two
  // tests spawn bfs from PROJECT_ROOT (unrelated cwd) and rely entirely on
  // `--cwd <vault>` to point the CLI at the right place — i.e. every
  // .bfs/cache, .bfs/push.lock, manifest path inside push must be derived
  // from the flag, not process.cwd().

  const nCwdVaultDir = path.join(nTmpDir, 'vault-cwd');
  const nCwdP1Dir = path.join(nTmpDir, 'cwd-p1');
  const nCwdP2Dir = path.join(nTmpDir, 'cwd-p2');
  const nCwdP3Dir = path.join(nTmpDir, 'cwd-p3');
  const nCwdPushLock = path.join(nCwdVaultDir, '.bfs', 'push.lock');
  const nCwdPushBlobPending = path.join(nCwdVaultDir, '.bfs', 'cache', 'push.blob.pending');

  tests.push(
    await runTest('N6', 'bfs --cwd <vault> push — healthy, cache + lock land under --cwd', async () => {
      await fs.mkdir(nCwdVaultDir, { recursive: true });
      await fs.mkdir(nCwdP1Dir, { recursive: true });
      await fs.mkdir(nCwdP2Dir, { recursive: true });
      await fs.mkdir(nCwdP3Dir, { recursive: true });
      await fs.writeFile(path.join(nCwdVaultDir, 'hello.txt'), 'Hello from --cwd!');

      const { io } = createMockProviderIO();
      const providers: ProviderConfig[] = [
        { id: 'cwd-p1', type: 'local', adapterPackage: null, config: { path: nCwdP1Dir } },
        { id: 'cwd-p2', type: 'local', adapterPackage: null, config: { path: nCwdP2Dir } },
        { id: 'cwd-p3', type: 'local', adapterPackage: null, config: { path: nCwdP3Dir } },
      ];
      await init(nCwdVaultDir, { vault_name: 'n-cwd-vault', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, push_mode: PushMode.NewVersion, providers, io });

      const r = runBfs(['push'], nCwdVaultDir, undefined, nEnv, true);
      assert(r.status === 0, `expected exit 0, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      // Healthy push cleans both artifacts under nCwdVaultDir — proving
      // the cleanup also resolves paths via --cwd (not process.cwd()).
      assert(!(await fileExists(nCwdPushLock)), 'push.lock should be removed on healthy push under --cwd');
      assert(!(await fileExists(nCwdPushBlobPending)), 'push.blob.pending should be removed on healthy push under --cwd');
      // Manifest v1 must land in the --cwd vault — proves rootDir
      // propagated all the way through manifest write.
      assert(await fileExists(path.join(nCwdVaultDir, '.bfs', 'manifests', 'v001.json')), 'manifest v001.json missing under --cwd vault');
    }),
  );

  tests.push(
    await runTest('N7', 'bfs --cwd <vault> push --cache — resume reads cache from --cwd, not process.cwd()', async () => {
      // Force a partial push so push.lock + push.blob.pending are written
      // into nCwdVaultDir, then resume with --cwd and --cache --overwrite.
      await fs.rm(nCwdP3Dir, { recursive: true, force: true });
      await fs.writeFile(nCwdP3Dir, 'sabotage');

      try {
        const partial = runBfs(['push'], nCwdVaultDir, undefined, nEnv, true);
        assert(partial.status !== 0, `expected non-zero exit for degraded push, got ${partial.status}`);
        assert(await fileExists(nCwdPushLock), 'push.lock should be retained after degraded push under --cwd');
        assert(await fileExists(nCwdPushBlobPending), 'push.blob.pending should be retained for --cache retry under --cwd');

        // Fix p3 and resume from cache via --cwd. Spawn cwd is
        // PROJECT_ROOT (unrelated) — only --cwd points BFS at the vault.
        await fs.unlink(nCwdP3Dir).catch(() => {});
        await fs.mkdir(nCwdP3Dir, { recursive: true });

        const resume = runBfs(['push', '--cache', '--overwrite'], nCwdVaultDir, undefined, nEnv, true);
        assert(resume.status === 0, `expected exit 0 on resume, got ${resume.status}\nstdout: ${resume.stdout}\nstderr: ${resume.stderr}`);
        assert(!(await fileExists(nCwdPushLock)), 'push.lock should be cleared after successful --cache --overwrite resume');
        assert(!(await fileExists(nCwdPushBlobPending)), 'push.blob.pending should be cleared after successful resume');
      } finally {
        await fs.unlink(nCwdP3Dir).catch(() => {});
        await fs.mkdir(nCwdP3Dir, { recursive: true });
      }
    }),
  );

  return { name: 'Suite N — push partial-commit + lockfile (PR1)', tests };
}
