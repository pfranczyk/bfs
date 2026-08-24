import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault, sha256 } from '../smoke-vault.js';

// --- Suite E - Versioning ----------------------------------------------------

export async function suiteE(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  // Remember the SHA-256 of the file we're going to modify
  const targetFile = 'hello.txt';
  const originalHash = ctx.originalHashes.get(targetFile);
  assert(originalHash !== undefined, `${targetFile} missing from originalHashes`);

  tests.push(
    await runTest('E1', `modify ${targetFile}`, async () => {
      const full = path.join(ctx.vaultDir, targetFile);
      await fs.writeFile(full, 'Modified content for version 2');
    }),
  );

  tests.push(
    await runTest('E2', 'bfs push (v2)', () => {
      const r = runBfs(['push'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('E3', 'bfs versions (contains 1 and 2)', () => {
      const r = runBfs(['versions'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/\b1\b/.test(out) && /\b2\b/.test(out), `expected 1 and 2 in output: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('E4', 'bfs pull --version 1 --force', () => {
      const r = runBfs(['pull', '--version', '1', '--force'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('E5', `SHA-256 ${targetFile} === v1 (original)`, async () => {
      const full = path.join(ctx.vaultDir, targetFile);
      const buf = await fs.readFile(full);
      const actual = sha256(buf);
      assert(actual === originalHash, `SHA mismatch: expected v1 hash ${originalHash}, got ${actual}`);
    }),
  );

  // E6 runs in its own vault so it can leave the working copy on an older version
  // without disturbing the shared one the later suites read. A push whose working
  // copy lags the latest reaches the version-switch confirmation; a smoke run has
  // no terminal, so without consent it must refuse - naming `bfs push --yes`, and
  // never `bfs pull` (whose confirmation would overwrite the working directory) -
  // and with `--yes` it must complete unattended.
  tests.push(
    await runTest('E6', 'push --yes consents to the version switch; without it a no-operator run refuses naming --yes', async () => {
      const base = path.dirname(ctx.vaultDir);
      const isoVault = path.join(base, 'e6-yes-vault');
      const providers = [
        { id: 'e6a', dir: path.join(base, 'e6-p0') },
        { id: 'e6b', dir: path.join(base, 'e6-p1') },
        { id: 'e6c', dir: path.join(base, 'e6-p2') },
      ];
      await initTestVault(isoVault, 'e6-yes', providers, ['--no-enc', '--no-compress']);

      const push1 = runBfs(['push'], isoVault);
      assert(push1.status === 0, `push v1 exit ${push1.status ?? 'null'}\n${push1.stderr}`);
      const push2 = runBfs(['push'], isoVault);
      assert(push2.status === 0, `push v2 exit ${push2.status ?? 'null'}\n${push2.stderr}`);

      // Drop the working copy back onto v1 while the latest stays v2 - the exact
      // state the version-switch gate guards. Editing state.json is the cheapest
      // way to reach it without a second full pull.
      const statePath = path.join(isoVault, '.bfs', 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
      await fs.writeFile(statePath, JSON.stringify({ ...state, working_version: 1 }));

      const refused = runBfs(['push'], isoVault);
      assert(refused.status !== 0, `push with no consent should refuse, got exit ${refused.status ?? 'null'}`);
      const refusedOut = refused.stdout + refused.stderr;
      assert(refusedOut.includes('--yes'), `refusal must name --yes: ${refusedOut.slice(0, 400)}`);
      assert(!/bfs pull/.test(refusedOut), `refusal must not send the operator to bfs pull: ${refusedOut.slice(0, 400)}`);

      const consented = runBfs(['push', '--yes'], isoVault);
      assert(consented.status === 0, `push --yes should complete, got exit ${consented.status ?? 'null'}\n${consented.stderr}`);

      const versions = runBfs(['versions'], isoVault);
      assert(/\b3\b/.test(versions.stdout + versions.stderr), `expected version 3 after push --yes: ${(versions.stdout + versions.stderr).slice(0, 300)}`);
    }),
  );

  return { name: 'Suite E - Versioning', tests };
}
