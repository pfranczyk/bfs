import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault } from '../smoke-vault.js';

// --- Suite S - Manifest shape gate -------------------------------------------
//
// A manifest file can hold something other than a manifest, and the two cases
// mean opposite things. A write cut short leaves a prefix no parser accepts:
// damage, which this directory cannot describe and therefore does not advertise.
// A record with nothing in it is deliberate - recovery puts it there for a
// version it found on the storage but could not open - and the operator has to
// learn about that one. Neither may reach the operator as a stack trace, and
// neither belongs in the table, whose columns describe a version this machine
// can actually read.

const VAULT_NAME = 'manifest-gate';

/** Absolute path of the manifest file for `version` inside a vault directory. */
function manifestPath(vaultDir: string, version: number): string {
  return path.join(vaultDir, '.bfs', 'manifests', `v${String(version).padStart(3, '0')}.json`);
}

export async function suiteS(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-s-${Date.now()}`);
  const vaultDir = path.join(tmpBase, 'vault');
  const providers = [
    { id: 'p1', dir: path.join(tmpBase, 'p1') },
    { id: 'p2', dir: path.join(tmpBase, 'p2') },
    { id: 'p3', dir: path.join(tmpBase, 'p3') },
  ];

  // -- S0 - setup: a vault with one pushed version ----------------------------

  tests.push(
    await runTest('S0', 'bfs init + push -> version 1 on three local providers', async () => {
      await initTestVault(vaultDir, VAULT_NAME, providers, ['--no-enc']);
      const r = runBfs(['push'], vaultDir);
      assert(r.status === 0, `push exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      await fs.access(manifestPath(vaultDir, 1));
    }),
  );

  // -- S1 - the record of an unrecovered version never becomes a table row ----

  tests.push(
    await runTest('S1', 'bfs versions with an unrecovered version -> no table row for it', async () => {
      await fs.writeFile(manifestPath(vaultDir, 2), '{}', 'utf-8');

      const r = runBfs(['versions'], vaultDir);

      const combined = `${r.stdout}${r.stderr}`;
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(combined.includes('v001'), `expected version 1 in the table, got:\n${combined}`);
      // Match the table's own row shape rather than a status word: a row whose
      // every unknown column rendered as "?" carries no status word at all and
      // would slip past a looser sieve.
      const rowLike = combined.split('\n').some((line) => /\|\s*v002\s*\|/.test(line));
      assert(!rowLike, `an unrecovered version has no scheme, part count or size - it must not be rendered as a table row, got:\n${combined}`);
      assert(!/undefined|Cannot read propert/i.test(combined), `expected no internal failure text, got:\n${combined}`);
    }),
  );

  // -- S2 - but the operator is told it exists --------------------------------

  tests.push(
    await runTest('S2', 'bfs versions names the version present on storage but not recovered', async () => {
      const r = runBfs(['versions'], vaultDir);

      const combined = `${r.stdout}${r.stderr}`;
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(/not recovered/i.test(combined), `expected the unrecovered-version line, got:\n${combined}`);
      assert(
        /\bv?0*2\b/.test(
          combined
            .split('\n')
            .filter((line) => /not recovered/i.test(line))
            .join('\n'),
        ),
        `the line must name the version, got:\n${combined}`,
      );
    }),
  );

  // -- S3 - bfs pull names the missing version instead of leaking a parse error -

  tests.push(
    await runTest('S3', 'bfs pull with a truncated manifest -> "was not found", no JSON parse error', async () => {
      const full = await fs.readFile(manifestPath(vaultDir, 1), 'utf-8');
      await fs.writeFile(manifestPath(vaultDir, 1), full.slice(0, Math.floor(full.length / 2)), 'utf-8');

      const r = runBfs(['pull', '--yes'], vaultDir);

      const combined = `${r.stdout}${r.stderr}`;
      assert(r.status !== 0, `a version with no readable manifest must not restore silently\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(combined.includes('was not found'), `expected the missing-version message, got:\n${combined}`);
      assert(!/JSON|SyntaxError/i.test(combined), `a parse error must not reach the operator, got:\n${combined}`);
    }),
  );

  // -- S4 - pull goes looking, and says what it found -------------------------
  //
  // The marker here stands for a version whose parts are NOT on the storages -
  // it was written by hand, and nothing was ever pushed under that number. A pull
  // that trusts the marker blindly would report a restore that cannot happen; one
  // that calls the version missing contradicts what `bfs versions` just listed.
  // Neither: it looks, finds nothing, and says exactly that.

  tests.push(
    await runTest('S4', 'bfs pull --version on a marker with no parts on the storage -> says none were found', async () => {
      const r = runBfs(['pull', '--version', '2', '--yes'], vaultDir);

      const combined = `${r.stdout}${r.stderr}`;
      assert(r.status !== 0, `nothing can be restored, so the run must not report success\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(/no parts of it/i.test(combined), `expected the message naming the missing parts, got:\n${combined}`);
      assert(!/was not found/i.test(combined), `this directory does record the version - calling it unknown contradicts what \`bfs versions\` lists, got:\n${combined}`);
    }),
  );

  // -- S5 - the line survives an empty table ----------------------------------

  tests.push(
    await runTest('S5', 'bfs versions with no readable manifest left -> still names the unrecovered version', async () => {
      const r = runBfs(['versions'], vaultDir);

      const combined = `${r.stdout}${r.stderr}`;
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(/not recovered/i.test(combined), `an empty table must not swallow the versions waiting on the storage, got:\n${combined}`);
    }),
  );

  // -- Cleanup ----------------------------------------------------------------

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  return { name: 'Suite S - Manifest shape gate', tests };
}
