import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault } from '../smoke-vault.js';

// --- Suite P - Repair (provider location repair, LocalFS) -------------------
//
// Covers `bfs repair`: an in-place provider repair after a path change. Pins
// the happy path (move storage, repair --path, success), the clean-abort path
// (a path with no shards fails and leaves repair.lock), and the capability
// boundary (a type:name migration is rejected). Both EN and PL phrasings are
// accepted - the harness runs in whatever locale the machine has persisted.

export async function suiteP(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-p-${Date.now()}`);
  const sourceDir = path.join(tmpBase, 'source');
  const p1Dir = path.join(tmpBase, 'p1');
  const p2Dir = path.join(tmpBase, 'p2');
  const p3Dir = path.join(tmpBase, 'p3');
  const newP1Dir = path.join(tmpBase, 'p1-moved');
  const emptyDir = path.join(tmpBase, 'empty');

  try {
    // P0 - fixture: init + push to 3 local providers
    tests.push(
      await runTest('P0', 'fixture: init + push to 3 local providers', async () => {
        await initTestVault(
          sourceDir,
          'repair-vault',
          [
            { id: 'p1', dir: p1Dir },
            { id: 'p2', dir: p2Dir },
            { id: 'p3', dir: p3Dir },
          ],
          ['--no-enc'],
        );
        const r = runBfs(['push'], sourceDir);
        assert(r.status === 0, `push exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
      }),
    );

    // P1 - physically move p1's storage, then repair to the new path
    tests.push(
      await runTest('P1', 'bfs repair p1 "--path <new>" -> exit 0', async () => {
        await fs.mkdir(newP1Dir, { recursive: true });
        await fs.rename(path.join(p1Dir, 'repair-vault'), path.join(newP1Dir, 'repair-vault'));
        const r = runBfs(['repair', '--version', 'all', 'p1', `--path ${newP1Dir}`], sourceDir);
        assert(r.status === 0, `repair exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('Repair completed') || combined.includes('Naprawa zakończona'), `expected repair success message, got:\n${combined}`);
      }),
    );

    // P2 - repairing to a path with no shards fails cleanly and keeps repair.lock
    tests.push(
      await runTest('P2', 'bfs repair to an empty path -> exit != 0', async () => {
        await fs.mkdir(emptyDir, { recursive: true });
        const r = runBfs(['repair', '--version', 'all', 'p2', `--path ${emptyDir}`], sourceDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('repair.lock') || combined.includes('Repair partial') || combined.includes('Naprawa częściowa'), `expected partial-repair message, got:\n${combined}`);
        const lockExists = await fs
          .stat(path.join(sourceDir, '.bfs', 'repair.lock'))
          .then(() => true)
          .catch(() => false);
        assert(lockExists, 'expected .bfs/repair.lock to be retained after a failed repair');
      }),
    );

    // P3 - a migration to an existing provider id is rejected (non-mutating)
    tests.push(
      await runTest('P3', 'bfs repair migration to an existing id -> exit != 0', async () => {
        const r = runBfs(['repair', 'p3', `local:p1 --path ${p3Dir}`], sourceDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('p1'), `expected an id-conflict error naming p1, got:\n${combined}`);
      }),
    );

    // P4 - --rebuild reconstructs a physically lost shard (p3 holds shard_2)
    tests.push(
      await runTest('P4', 'bfs repair --rebuild reconstructs a lost shard -> exit 0', async () => {
        await fs.rm(path.join(p3Dir, 'repair-vault', 'shard_2.bfs.1'));
        const r = runBfs(['repair', '--version', '1', 'p3', '', '--rebuild'], sourceDir);
        assert(r.status === 0, `repair --rebuild exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        const restored = await fs
          .stat(path.join(p3Dir, 'repair-vault', 'shard_2.bfs.1'))
          .then(() => true)
          .catch(() => false);
        assert(restored, 'expected the lost shard to be reconstructed by --rebuild');
      }),
    );

    // P5 - a type/id migration re-points a moved shard to a new provider
    tests.push(
      await runTest('P5', 'bfs repair migrates a provider to a new id -> exit 0', async () => {
        const p9Dir = path.join(tmpBase, 'p9-storage');
        await fs.mkdir(p9Dir, { recursive: true });
        await fs.rename(path.join(p3Dir, 'repair-vault'), path.join(p9Dir, 'repair-vault'));
        const r = runBfs(['repair', '--version', 'all', 'p3', `local:p9 --path ${p9Dir}`], sourceDir);
        assert(r.status === 0, `migration exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        const manifest = await fs.readFile(path.join(sourceDir, '.bfs', 'manifests', 'v001.json'), 'utf8');
        assert(manifest.includes('p9'), `expected the manifest to name the migrated provider p9, got:\n${manifest}`);
      }),
    );

    // P6 - --restore-headers is a registered option that rebuilds header files
    tests.push(
      await runTest('P6', 'bfs repair --help lists --restore-headers -> exit 0', async () => {
        const r = runBfs(['repair', '--help'], sourceDir);
        assert(r.status === 0, `repair --help exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('--restore-headers'), `expected --restore-headers in repair help, got:\n${combined}`);
      }),
    );

    // `--lang` persists the choice in global settings, so these runs get their
    // own config home - otherwise the suite would leave the machine (and every
    // later suite in the same run) switched to whichever language it asked for.
    const helpLangDir = path.join(tmpBase, 'lang-home');
    await fs.mkdir(helpLangDir, { recursive: true });
    const helpEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: helpLangDir };

    /** The `--rebuild` entry of a help listing, anchored to the option line. */
    const rebuildEntry = (out: string): string => {
      const match = /^[ \t]+--rebuild\b/m.exec(out);
      if (match === null) return '';
      const rest = out.slice(match.index + match[0].length);
      const next = rest.search(/\n[ \t]+-/);
      return next === -1 ? rest : rest.slice(0, next);
    };

    // P7 - the help must show HOW to invoke repair. The command takes a device
    // name and a settings string, but both arrive as unparsed operands, so the
    // generated usage line (`bfs repair [options]`) reveals neither: an operator
    // reading the help cannot work out the syntax.
    tests.push(
      await runTest('P7', 'bfs repair --help shows the device + settings syntax', () => {
        const r = runBfs(['--lang', 'en', 'repair', '--help'], sourceDir, undefined, helpEnv);
        assert(r.status === 0, `repair --help exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(/bfs repair\s+\S+\s+["'<]/.test(combined), `expected the device + settings syntax in the help, got:\n${combined}`);
        assert(/--rebuild/.test(combined) && /example|przykład|e\.g\./i.test(combined), `expected a worked example in the help, got:\n${combined}`);
        // An example must be runnable as printed. A `type:name` prefix means
        // "migrate to a new device", which is rejected outright when the name is
        // one the backup already uses - so it cannot illustrate repairing an
        // existing device.
        const examples = combined.split('\n').filter((line) => /^\s*bfs repair\b/.test(line));
        assert(examples.length > 0, `expected example invocations in the help, got:\n${combined}`);
        for (const line of examples) {
          assert(!/"\s*[a-z0-9-]+:[a-z0-9-]+/i.test(line), `example uses the migrate-to-a-new-device form, which fails for an existing device:\n${line}`);
        }
      }),
    );

    // P8 - a part that is present but rotted is repaired by the same flag as a
    // lost one (rebuildShardInPlace reconstructs and uploads unconditionally),
    // yet the description mentions only loss, so nobody in that situation tries
    // it - while `prune`'s refusal already points them at this very command.
    tests.push(
      await runTest('P8', 'bfs repair --help says --rebuild also fixes damaged data (EN + PL)', () => {
        const en = runBfs(['--lang', 'en', 'repair', '--help'], sourceDir, undefined, helpEnv);
        const enEntry = rebuildEntry(en.stdout + en.stderr);
        assert(/damaged|corrupt/i.test(enEntry), `--rebuild must mention damaged data, its entry reads:\n${enEntry}`);

        const pl = runBfs(['--lang', 'pl', 'repair', '--help'], sourceDir, undefined, helpEnv);
        const plEntry = rebuildEntry(pl.stdout + pl.stderr);
        assert(/uszkodzon/i.test(plEntry), `Polish --rebuild entry must mention damaged data, it reads:\n${plEntry}`);
      }),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  return { name: 'Suite P - Repair (LocalFS)', tests };
}
