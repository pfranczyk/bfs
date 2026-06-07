import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault, readJson, verifyShaHashes } from '../smoke-vault.js';

// ─── Suite J — ZIP Compression ───────────────────────────────────────────────

export async function suiteJ(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-j-${Date.now()}`);
  const vaultDir = path.join(tmpBase, 'vault');
  const p1Dir = path.join(tmpBase, 'p1');
  const p2Dir = path.join(tmpBase, 'p2');
  const p3Dir = path.join(tmpBase, 'p3');
  let originalHashes = new Map<string, string>();

  // ── J0 — setup: init without --no-compress (compression ON by default) ──────

  tests.push(
    await runTest('J0', 'bfs init --ci (without --no-compress) — compression.enabled=true in config', async () => {
      originalHashes = await initTestVault(
        vaultDir,
        'zip-vault',
        [
          { id: 'p1', dir: p1Dir },
          { id: 'p2', dir: p2Dir },
          { id: 'p3', dir: p3Dir },
        ],
        ['--no-enc'],
      );
      const cfg = await readJson<{ compression?: { enabled: boolean } }>(path.join(vaultDir, '.bfs', 'config.json'));
      assert(cfg.compression?.enabled === true, `expected compression.enabled=true in config, got: ${JSON.stringify(cfg.compression)}`);
    }),
  );

  // ── J1 — push → manifest.compressed=true ──────────────────────────────────

  tests.push(
    await runTest('J1', 'bfs push → exit 0, manifest v1 compressed=true', async () => {
      const r = runBfs(['push'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const manifest = await readJson<{ compressed?: boolean }>(path.join(vaultDir, '.bfs', 'manifests', 'v001.json'));
      assert(manifest.compressed === true, `expected compressed=true in manifest, got: ${JSON.stringify(manifest.compressed)}`);
    }),
  );

  // ── J2 — pull → SHA-256 matches original ─────────────────────────────────

  tests.push(
    await runTest('J2', 'bfs pull --force → exit 0, SHA-256 of restored files match', async () => {
      const entries = await fs.readdir(vaultDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.bfs') continue;
        await fs.rm(path.join(vaultDir, entry.name), { recursive: true });
      }
      const r = runBfs(['pull', '--force'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      await verifyShaHashes(vaultDir, originalHashes, 'after pull');
    }),
  );

  // ── J3 — init --no-compress → compressed absent in manifest ──────────────

  tests.push(
    await runTest('J3', 'bfs init --ci --no-compress → push → manifest.compressed nieobecne', async () => {
      const noCompDir = path.join(tmpBase, 'no-compress');
      await initTestVault(
        noCompDir,
        'nc-vault',
        [
          { id: 'nc1', dir: path.join(tmpBase, 'nc1') },
          { id: 'nc2', dir: path.join(tmpBase, 'nc2') },
          { id: 'nc3', dir: path.join(tmpBase, 'nc3') },
        ],
        ['--no-compress', '--no-enc'],
      );
      const rp = runBfs(['push'], noCompDir);
      assert(rp.status === 0, `push exit ${rp.status ?? 'null'}\n${rp.stdout}\n${rp.stderr}`);
      const manifest = await readJson<{ compressed?: boolean }>(path.join(noCompDir, '.bfs', 'manifests', 'v001.json'));
      assert(manifest.compressed !== true, `expected no compressed=true with --no-compress, got: ${JSON.stringify(manifest.compressed)}`);
    }),
  );

  // ── J4 — init with compression, push --no-compress → compressed absent ───────

  tests.push(
    await runTest('J4', 'init (compression ON) + push --no-compress → manifest without compressed', async () => {
      const overDir = path.join(tmpBase, 'override-off');
      await initTestVault(
        overDir,
        'ov-vault',
        [
          { id: 'oo1', dir: path.join(tmpBase, 'oo1') },
          { id: 'oo2', dir: path.join(tmpBase, 'oo2') },
          { id: 'oo3', dir: path.join(tmpBase, 'oo3') },
        ],
        ['--no-enc'],
      );
      const rp = runBfs(['push', '--no-compress'], overDir);
      assert(rp.status === 0, `push exit ${rp.status ?? 'null'}\n${rp.stdout}\n${rp.stderr}`);
      const manifest = await readJson<{ compressed?: boolean }>(path.join(overDir, '.bfs', 'manifests', 'v001.json'));
      assert(manifest.compressed !== true, `expected no compressed=true with push --no-compress, got: ${JSON.stringify(manifest.compressed)}`);
    }),
  );

  // ── J5 — init --no-compress, push --compress → compressed=true ─────────────

  tests.push(
    await runTest('J5', 'init --no-compress + push --compress → manifest.compressed=true', async () => {
      const overOnDir = path.join(tmpBase, 'override-on');
      await initTestVault(
        overOnDir,
        'on-vault',
        [
          { id: 'on1', dir: path.join(tmpBase, 'on1') },
          { id: 'on2', dir: path.join(tmpBase, 'on2') },
          { id: 'on3', dir: path.join(tmpBase, 'on3') },
        ],
        ['--no-compress', '--no-enc'],
      );
      const rp = runBfs(['push', '--compress'], overOnDir);
      assert(rp.status === 0, `push exit ${rp.status ?? 'null'}\n${rp.stdout}\n${rp.stderr}`);
      const manifest = await readJson<{ compressed?: boolean }>(path.join(overOnDir, '.bfs', 'manifests', 'v001.json'));
      assert(manifest.compressed === true, `oczekiwano compressed=true gdy push --compress, got: ${JSON.stringify(manifest.compressed)}`);
    }),
  );

  // ── J6 — push --compress + --no-compress simultaneously → exit != 0 ─────────

  tests.push(
    await runTest('J6', 'bfs push --compress --no-compress → exit != 0, error message', () => {
      const r = runBfs(['push', '--compress', '--no-compress'], vaultDir);
      assert(r.status !== 0, `expected exit != 0 for conflicting --compress + --no-compress, got ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/compress/i.test(out), `expected compression conflict message: ${out.slice(0, 300)}`);
    }),
  );

  // ── Cleanup ────────────────────────────────────────────────────────────────

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  return { name: 'Suite J — ZIP Compression', tests };
}
