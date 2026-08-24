import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault, readJson, verifyShaHashes } from '../smoke-vault.js';

// --- Suite M - Recovery (--bootstrap, LocalFS) -----------------------------
//
// Regression coverage for the user-reported bug where
// `bfs recovery --provider <type> --path ...` silently dropped adapter
// credentials (no port/password/host) on remote providers, producing
// "530 Login incorrect" on FTP. The new --bootstrap spec forwards adapter
// flags verbatim to configureFromFlags via parseRecoveryBootstrapSpec -
// same grammar as `bfs init --ci`. These tests pin both the happy path
// (LocalFS round-trip) and the validation surface (missing/invalid flags).

export async function suiteM(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-m-${Date.now()}`);
  const sourceDir = path.join(tmpBase, 'source');
  const restoreDir = path.join(tmpBase, 'restore');
  const p1Dir = path.join(tmpBase, 'p1');
  const p2Dir = path.join(tmpBase, 'p2');
  const p3Dir = path.join(tmpBase, 'p3');

  try {
    // M0 - bootstrap fixture: init + push to local providers
    let originalHashes: Map<string, string> = new Map();
    tests.push(
      await runTest('M0', 'fixture: init + push to 3 local providers', async () => {
        originalHashes = await initTestVault(
          sourceDir,
          'recovery-vault',
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

    // M1 - recovery into an empty directory using the bootstrap spec
    tests.push(
      await runTest('M1', 'bfs recovery --provider local --bootstrap "--path ..." rebuilds .bfs/', async () => {
        await fs.mkdir(restoreDir, { recursive: true });
        const r = runBfs(['recovery', '--provider', 'local', '--name', 'recovery-vault', '--bootstrap', `--path ${p1Dir}`], restoreDir);
        assert(r.status === 0, `recovery exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);

        const manifest = await readJson<{ version: number }>(path.join(restoreDir, '.bfs', 'manifests', 'v001.json'));
        assert(manifest.version === 1, `manifest v001.version expected 1, got ${manifest.version}`);
      }),
    );

    // M2 - bfs pull after recovery restores the original files
    tests.push(
      await runTest('M2', 'bfs pull after recovery restores files (SHA match)', async () => {
        const r = runBfs(['pull', '--force'], restoreDir);
        assert(r.status === 0, `pull exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
        await verifyShaHashes(restoreDir, originalHashes, 'after recovery + pull');
      }),
    );

    // M3 - --bootstrap without --provider is rejected.
    // Asserts on both EN and PL phrasings - the smoke harness picks up
    // whatever locale the test machine has persisted in settings.json.
    tests.push(
      await runTest('M3', 'bfs recovery --bootstrap without --provider -> exit != 0', async () => {
        const r = runBfs(['recovery', '--name', 'recovery-vault', '--bootstrap', `--path ${p1Dir}`], restoreDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('--bootstrap requires --provider') || combined.includes('Flaga --bootstrap wymaga --provider'), `expected --bootstrap requires --provider error, got:\n${combined}`);
      }),
    );

    // M4 - --bootstrap without --name is rejected
    tests.push(
      await runTest('M4', 'bfs recovery --bootstrap without --name -> exit != 0', async () => {
        const r = runBfs(['recovery', '--provider', 'local', '--bootstrap', `--path ${p1Dir}`], restoreDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('--bootstrap requires --name') || combined.includes('Flaga --bootstrap wymaga --name'), `expected --bootstrap requires --name error, got:\n${combined}`);
      }),
    );

    // M5 - empty --bootstrap spec is rejected
    tests.push(
      await runTest('M5', 'bfs recovery --bootstrap "" -> exit != 0', async () => {
        const r = runBfs(['recovery', '--provider', 'local', '--name', 'recovery-vault', '--bootstrap', ''], restoreDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('Bootstrap spec is empty') || combined.includes('Spec --bootstrap jest pusty'), `expected empty-spec error, got:\n${combined}`);
      }),
    );

    // M6 - unknown provider type is rejected
    tests.push(
      await runTest('M6', 'bfs recovery --provider made-up-xyz -> exit != 0', async () => {
        const r = runBfs(['recovery', '--provider', 'made-up-xyz', '--name', 'recovery-vault', '--bootstrap', `--path ${p1Dir}`], restoreDir);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('Unknown provider type') || combined.includes('Nieznany typ nośnika'), `expected unknown-type error, got:\n${combined}`);
      }),
    );

    // M7 - --config-file is a first-class --bootstrap value.
    // Pins the contract: any adapter flag understood by configureFromFlags
    // (here `--config-file <path>` reading {path: "..."} from JSON) works
    // when wrapped in the bootstrap spec. Critical for adapters with bulky
    // credentials (SSH private keys, OAuth tokens) where command-line flags
    // are impractical - users keep secrets in a file instead.
    tests.push(
      await runTest('M7', 'bfs recovery --bootstrap "--config-file ..." rebuilds .bfs/', async () => {
        const cfgPath = path.join(restoreDir, 'local-bootstrap.json');
        await fs.writeFile(cfgPath, JSON.stringify({ path: p1Dir }, null, 2), 'utf8');

        // Wipe restoreDir's .bfs/ but keep the bootstrap config.
        const bfsDir = path.join(restoreDir, '.bfs');
        await fs.rm(bfsDir, { recursive: true, force: true });

        const r = runBfs(['recovery', '--provider', 'local', '--name', 'recovery-vault', '--bootstrap', '--config-file ./local-bootstrap.json'], restoreDir);
        assert(r.status === 0, `recovery exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const manifestExists = await fs
          .stat(path.join(bfsDir, 'manifests', 'v001.json'))
          .then(() => true)
          .catch(() => false);
        assert(manifestExists, `expected v001.json after recovery via --config-file, got:\n${r.stdout}\n${r.stderr}`);
      }),
    );

    // M8 - Polish locale renders the new error keys.
    // Anti-regression for hardcoded English strings introduced during refactor.
    // Uses XDG_CONFIG_HOME to keep the language setting out of the settings file
    // the rest of the run shares (matches Suite F's pattern).
    tests.push(
      await runTest('M8', 'i18n PL: --bootstrap errors rendered in Polish', async () => {
        const langConfigDir = path.join(tmpBase, 'lang-config');
        await fs.mkdir(langConfigDir, { recursive: true });
        const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: langConfigDir };
        // Persist Polish locale into the isolated config first.
        const setLang = runBfs(['--lang', 'pl', 'status'], restoreDir, undefined, langEnv);
        assert(setLang.status === 0, `--lang pl setup failed: ${setLang.stderr}`);

        const r = runBfs(['recovery', '--name', 'recovery-vault', '--bootstrap', `--path ${p1Dir}`], restoreDir, undefined, langEnv);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('Flaga --bootstrap wymaga --provider'), `expected Polish error message, got:\n${combined}`);
      }),
    );

    // M9 - an encrypted backup recovered with no password, by a run nobody is
    // watching. The password cannot be asked for here: an unanswerable prompt
    // never settles, so the run dies where it stands instead of finishing. The
    // refusal has to name how to supply the password, and no prompt may appear.
    tests.push(
      await runTest('M9', 'bfs recovery of an encrypted backup with no password -> refusal naming --password, no prompt', async () => {
        const encSource = path.join(tmpBase, 'enc-source');
        const encRestore = path.join(tmpBase, 'enc-restore');
        const q1Dir = path.join(tmpBase, 'q1');
        await initTestVault(
          encSource,
          'enc-recovery-vault',
          [
            { id: 'q1', dir: q1Dir },
            { id: 'q2', dir: path.join(tmpBase, 'q2') },
            { id: 'q3', dir: path.join(tmpBase, 'q3') },
          ],
          ['--no-compress'],
        );
        const pushed = runBfs(['push', '--password', 'smoke-m9-secret'], encSource);
        assert(pushed.status === 0, `push exit ${pushed.status ?? 'null'}\n${pushed.stdout}\n${pushed.stderr}`);

        await fs.mkdir(encRestore, { recursive: true });
        const r = runBfs(['recovery', '--provider', 'local', '--name', 'enc-recovery-vault', '--bootstrap', `--path ${q1Dir}`], encRestore);
        assert(r.status !== 0, `expected non-zero exit, got ${r.status}\n${r.stdout}\n${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('--password'), `refusal must name how to supply the password, got:\n${combined}`);
        assert(!combined.includes('Enter password for version') && !combined.includes('Podaj hasło dla wersji'), `recovery must not prompt when no one can answer, got:\n${combined}`);
      }),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  return { name: 'Suite M - Recovery (--bootstrap, LocalFS)', tests };
}
