import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';

// ─── Suite A — CLI bootstrap ──────────────────────────────────────────────────

export async function suiteA(vaultDir: string): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  tests.push(
    await runTest('A1', 'bfs --help', () => {
      const r = runBfs(['--help'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}, expected 0`);
      const out = r.stdout + r.stderr;
      assert(out.includes('push') && out.includes('pull') && out.includes('verify'), `stdout missing push/pull/verify: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('A2', 'bfs -V', () => {
      const r = runBfs(['-V'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}, expected 0`);
      const out = r.stdout + r.stderr;
      assert(/\d+\.\d+\.\d+/.test(out), `version not found in: ${out.slice(0, 100)}`);
    }),
  );

  tests.push(
    await runTest('A3', 'bfs nieznana-komenda', () => {
      const r = runBfs(['nieznana-komenda'], vaultDir);
      assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/unknown command|error/i.test(out), `expected error message in: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('A4', 'bfs pull --host rejected (removed option)', () => {
      const r = runBfs(['pull', '--host', '192.168.1.10'], vaultDir);
      assert(r.status !== 0, `expected non-zero exit for unknown --host, got ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/unknown option|error/i.test(out), `expected error message in: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('A5', 'bfs recovery --host rejected (removed option)', () => {
      const r = runBfs(['recovery', '--host', '192.168.1.10', '--provider', 'local', '--path', '/tmp', '--name', 'x'], vaultDir);
      assert(r.status !== 0, `expected non-zero exit for unknown --host, got ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/unknown option|error/i.test(out), `expected error message in: ${out.slice(0, 200)}`);
    }),
  );

  // ── CI-mode validation: regression for silent null-scheme config ─────────
  // bfs init --ci must refuse incomplete arg sets instead of emitting a config
  // with scheme.data_shards=null that crashes push later.

  tests.push(
    await runTest('A6', 'bfs init --ci bez vault_name → abort', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-a-'));
      try {
        const r = runBfs(['init', '--ci', '--data-shards', '2', '--parity-shards', '1'], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('backup name') || out.includes('nazwy kopii'), `expected CI name required message, got: ${out.slice(0, 200)}`);
        const cfgExists = await fs
          .stat(path.join(dir, '.bfs', 'config.json'))
          .then(() => true)
          .catch(() => false);
        assert(!cfgExists, 'config.json must NOT be written on validation abort');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A7', 'bfs init --ci <name> bez --data-shards → abort', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-a-'));
      try {
        const r = runBfs(['init', 'v', '--ci', '--parity-shards', '1'], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('--data-shards') && out.includes('--parity-shards'), `expected scheme-required message, got: ${out.slice(0, 200)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A8', 'bfs init --ci with --data-shards 1 (too few) → abort', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-a-'));
      try {
        const r = runBfs(['init', 'v', '--ci', '--data-shards', '1', '--parity-shards', '1', '--provider', `local:p1 --path ${dir}`, '--provider', `local:p2 --path ${dir}`], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('data-shards'), `expected data-shards invalid message, got: ${out.slice(0, 200)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A9', 'bfs init --ci with insufficient --provider count → abort', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-a-'));
      try {
        const r = runBfs(['init', 'v', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', `local:p1 --path ${dir}`, '--provider', `local:p2 --path ${dir}`], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('--ci mode requires 3') || out.includes('Tryb --ci wymaga 3'), `expected providers-required message, got: ${out.slice(0, 200)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // ── Duplicate provider id rejection ──────────────────────────────────────
  // bfs init --ci rejects two --provider specs that share an id; a duplicate
  // would otherwise land in config.json and break push later. Guards exit≠0
  // and that no config is written.

  tests.push(
    await runTest('A10', 'bfs init --ci with duplicate --provider id → abort', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-a-'));
      try {
        const r = runBfs(['init', 'v', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', `local:dup --path ${dir}`, '--provider', `local:dup --path ${dir}`, '--provider', `local:ok --path ${dir}`], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('dup'), `expected colliding id in message, got: ${out.slice(0, 200)}`);
        const cfgExists = await fs
          .stat(path.join(dir, '.bfs', 'config.json'))
          .then(() => true)
          .catch(() => false);
        assert(!cfgExists, 'config.json must NOT be written when a duplicate provider id is given');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // ── Vault name path-traversal rejection ──────────────────────────────────
  // A vault name becomes a path segment under each provider's base path
  // ({base}/{vault_name}/shard_...). init must reject names containing path
  // separators or '..' so a name like '../evil' or 'a/b' cannot write shards
  // outside the configured base. Guards exit≠0 AND that no traversal/separator
  // directory materialises on disk. Does NOT assert the exact i18n message —
  // only exit code and the absence of a side-effect.

  tests.push(
    await runTest('A11', 'bfs init --ci --name "../evil" → abort, no traversal dir', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-trav-'));
      try {
        const r = runBfs(['init', '../evil', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', `local:p1 --path ${dir}`, '--provider', `local:p2 --path ${dir}`, '--provider', `local:p3 --path ${dir}`], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);

        // The escape target would be a sibling 'evil' dir next to `dir`
        // (dir/../evil). It must not exist.
        const escaped = await fs
          .stat(path.join(path.dirname(dir), 'evil'))
          .then(() => true)
          .catch(() => false);
        assert(!escaped, 'vault name "../evil" must NOT create a directory outside the base path');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await fs.rm(path.join(path.dirname(dir), 'evil'), { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A12', 'bfs init --ci --name "a/b" → abort, no nested dir', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-trav-'));
      try {
        const r = runBfs(['init', 'a/b', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', `local:p1 --path ${dir}`, '--provider', `local:p2 --path ${dir}`, '--provider', `local:p3 --path ${dir}`], dir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status ?? 'null'}`);

        // A 'a/b' name would create a nested base/a/b shard directory.
        const nested = await fs
          .stat(path.join(dir, 'a', 'b'))
          .then(() => true)
          .catch(() => false);
        assert(!nested, 'vault name "a/b" must NOT create a nested directory under the base path');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  return { name: 'Suite A — CLI bootstrap', tests };
}
