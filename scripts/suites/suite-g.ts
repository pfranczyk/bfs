import fs from 'node:fs/promises';
import path from 'node:path';
// Side-effect: registers the "local" type in ProviderRegistry
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init } from '../../src/vault/vault-manager.js';
import { assert, denyRead, restoreRead, runBfs, runTest, skipTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists } from '../smoke-vault.js';

// --- Suite G - Cache & Clear --------------------------------------------------

/**
 * Tests: bfs clear, bfs push (abort + cache), bfs push --cache,
 * bfs pull (abort + cache), bfs pull --cache, --cache option descriptions in
 * --help, and --password-file on an encrypted vault (G8/G9) - the only layer
 * where a real subprocess can prove the password never reaches the output.
 *
 * Uses its own vault isolated from the main ctx.
 * Permission-blocking technique: chmod (Unix) / icacls (Windows) - no admin needed,
 * because we block files we created ourselves (we are the owner).
 * For G6 we block a specific FILE (not a directory), to avoid EPERM on scandir -
 * restricted/ and .bfs/cache/ remain accessible.
 */
export async function suiteG(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const gTmpDir = path.join(ctx.sourceDir, 'g-cache');
  const gVaultDir = path.join(gTmpDir, 'vault');
  const gP1Dir = path.join(gTmpDir, 'p1');
  const gP2Dir = path.join(gTmpDir, 'p2');
  const gP3Dir = path.join(gTmpDir, 'p3');
  const secretBinPath = path.join(gVaultDir, 'secret.bin');
  // Isolated config dir -> no settings.json -> default lang 'en'
  const gLangDir = path.join(gTmpDir, 'lang-config');
  const gEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: gLangDir };

  // -- G0: Setup --------------------------------------------------------------

  tests.push(
    await runTest('G0', 'setup: vault G (cache tests)', async () => {
      await fs.mkdir(gVaultDir, { recursive: true });
      await fs.mkdir(gP1Dir, { recursive: true });
      await fs.mkdir(gP2Dir, { recursive: true });
      await fs.mkdir(gP3Dir, { recursive: true });
      await fs.mkdir(gLangDir, { recursive: true });

      await fs.writeFile(path.join(gVaultDir, 'normal.txt'), 'normal file');
      await fs.writeFile(secretBinPath, 'secret content');

      const { io } = createMockProviderIO();
      const gProviders: ProviderConfig[] = [
        { id: 'gp1', type: 'local', adapterPackage: null, config: { path: gP1Dir } },
        { id: 'gp2', type: 'local', adapterPackage: null, config: { path: gP2Dir } },
        { id: 'gp3', type: 'local', adapterPackage: null, config: { path: gP3Dir } },
      ];
      await init(gVaultDir, { vault_name: 'g-vault', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, push_mode: PushMode.NewVersion, providers: gProviders, io });
    }),
  );

  // -- G1: bfs clear ----------------------------------------------------------

  tests.push(
    await runTest('G1', 'bfs clear - removes both cache files', async () => {
      const cacheDir = path.join(gVaultDir, '.bfs', 'cache');
      const pushPending = path.join(cacheDir, 'push.blob.pending');
      const pullPending = path.join(cacheDir, 'pull.blob.pending');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(pushPending, 'dummy push');
      await fs.writeFile(pullPending, 'dummy pull');

      const r = runBfs(['clear'], gVaultDir, undefined, gEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Cache cleared.') || out.includes('Cache wyczyszczony'), `expected clear_done in: ${out.slice(0, 300)}`);
      assert(!(await fileExists(pushPending)), 'push.blob.pending was not removed');
      assert(!(await fileExists(pullPending)), 'pull.blob.pending was not removed');
    }),
  );

  // -- G2/G3: --cache option descriptions in --help (EN) ------------------------------

  tests.push(
    await runTest('G2', 'bfs push --help contains --cache description (EN)', () => {
      const r = runBfs(['push', '--help'], gVaultDir, undefined, gEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('Upload cached backup data') || out.includes('cached backup data'), `--cache description missing in bfs push --help: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('G3', 'bfs pull --help contains --cache description (EN)', () => {
      const r = runBfs(['pull', '--help'], gVaultDir, undefined, gEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('Retry using cached backup data') || out.includes('cached backup data'), `--cache description missing in bfs pull --help: ${out.slice(0, 500)}`);
    }),
  );

  // -- G4/G5: bfs push abort on an unreadable file, then resume from cache ----
  // The abort is staged by making a file unreadable (denyRead). POSIX root
  // bypasses file-mode permission checks, so chmod 000 cannot make the file
  // unreadable for the push process - the precondition is impossible as root
  // (e.g. a docker-executor CI runner). Skip the abort/cache assertions there,
  // but still create a healthy version so G6/G7 (which pull it) have data.
  const cannotDenyRead = typeof process.getuid === 'function' && process.getuid() === 0;

  if (cannotDenyRead) {
    tests.push(skipTest('G4', 'bfs push - abort + push.blob.pending on unreadable file', 'running as root - chmod cannot make a file unreadable'));
    tests.push(skipTest('G5', 'bfs push --cache - upload from cache after abort', 'depends on the G4 abort cache (skipped as root)'));
    tests.push(
      await runTest('G5b', 'bfs push (healthy) - version for G6/G7 when G4/G5 skipped as root', () => {
        const r = runBfs(['push'], gVaultDir, undefined, gEnv);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      }),
    );
  } else {
    tests.push(
      await runTest('G4', 'bfs push - abort + push.blob.pending on unreadable file', async () => {
        denyRead(secretBinPath);
        try {
          const r = runBfs(['push'], gVaultDir, undefined, gEnv);
          assert(r.status === 1, `expected exit 1, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
          const out = r.stdout + r.stderr;
          assert(/could not be read|nie można było odczytać/i.test(out), `expected push_skipped_header in: ${out.slice(0, 500)}`);
          assert(out.includes('bfs push --cache'), `expected "bfs push --cache" hint in: ${out.slice(0, 500)}`);
          assert(await fileExists(path.join(gVaultDir, '.bfs', 'cache', 'push.blob.pending')), 'push.blob.pending should exist after abort');
        } finally {
          restoreRead(secretBinPath);
        }
      }),
    );

    tests.push(
      await runTest('G5', 'bfs push --cache - upload from cache after abort', () => {
        const r = runBfs(['push', '--cache'], gVaultDir, undefined, gEnv);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      }),
    );
  }

  // -- G6: bfs pull -y abort + pull.blob.pending (EISDIR) --------------------

  const normalTxtPath = path.join(gVaultDir, 'normal.txt');

  tests.push(
    await runTest('G6', 'bfs pull -y - abort + pull.blob.pending (EISDIR)', async () => {
      // Replace normal.txt with a directory of the same name -> EISDIR on writeFile
      await fs.unlink(normalTxtPath).catch(() => {});
      await fs.mkdir(normalTxtPath, { recursive: true });

      try {
        const r = runBfs(['pull', '-y'], gVaultDir, undefined, gEnv);
        assert(r.status === 1, `expected exit 1, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const out = r.stdout + r.stderr;
        assert(/could not be written|nie można było zapisać/i.test(out), `expected pull_skipped_header in: ${out.slice(0, 500)}`);
        assert(out.includes('bfs pull --cache'), `expected "bfs pull --cache" hint in: ${out.slice(0, 500)}`);
        assert(await fileExists(path.join(gVaultDir, '.bfs', 'cache', 'pull.blob.pending')), 'pull.blob.pending should exist after abort');
      } finally {
        // Remove the lock (directory) - G7 also removes it, but cleaning up here for safety
        await fs.rm(normalTxtPath, { recursive: true, force: true });
      }
    }),
  );

  // -- G7: bfs pull --cache -y after removing lock ---------------------------

  tests.push(
    await runTest('G7', 'bfs pull --cache -y - restore file after removing lock', async () => {
      // Lock removed in G6 finally; normal.txt does not exist now
      const r = runBfs(['pull', '--cache', '-y'], gVaultDir, undefined, gEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      assert(await fileExists(normalTxtPath), 'normal.txt should be restored after pull --cache');
    }),
  );

  // -- G8: --password-file keeps the secret out of argv ----------------------

  tests.push(
    await runTest('G8', 'bfs push --password-file - encrypted vault, password never printed', async () => {
      const encDir = path.join(gTmpDir, 'enc');
      const encVault = path.join(encDir, 'vault');
      const encProviders = [path.join(encDir, 'p1'), path.join(encDir, 'p2'), path.join(encDir, 'p3')];
      for (const d of [encVault, ...encProviders]) await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(encVault, 'hello.txt'), 'secret payload\n');

      const secret = 'file-only-password';
      const passFile = path.join(encDir, 'vault.pass');
      // Trailing newline is what `echo > file` leaves; it must not be taken as
      // part of the password.
      await fs.writeFile(passFile, `${secret}\n`, { mode: 0o600 });

      await init(encVault, {
        vault_name: 'enc-vault',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: encProviders.map((d, i) => ({ id: `ep${i + 1}`, type: 'local', adapterPackage: null, config: { path: d } }) as ProviderConfig),
        push_mode: PushMode.NewVersion,
        io: createMockProviderIO().io,
      });

      const r = runBfs(['push', '--new', '--password-file', passFile], encVault, undefined, gEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

      // The whole point of the flag: the secret must not surface anywhere the
      // operator or a log collector can see it.
      const out = `${r.stdout}${r.stderr}`;
      assert(!out.includes(secret), `password leaked into CLI output: ${out.slice(0, 500)}`);

      // And it really was used - a wrong password could not have produced a
      // readable restore.
      await fs.rm(path.join(encVault, 'hello.txt'));
      const pullRun = runBfs(['pull', '--force', '--yes', '--password-file', passFile], encVault, undefined, gEnv);
      assert(pullRun.status === 0, `pull exit ${pullRun.status ?? 'null'}\nstdout: ${pullRun.stdout}\nstderr: ${pullRun.stderr}`);
      assert(await fileExists(path.join(encVault, 'hello.txt')), 'hello.txt should be restored via --password-file');
    }),
  );

  tests.push(
    await runTest('G9', 'bfs push --password-file <missing> - names the file, no raw ENOENT', async () => {
      const missing = path.join(gTmpDir, 'enc', 'nope.pass');
      const r = runBfs(['push', '--new', '--password-file', missing], path.join(gTmpDir, 'enc', 'vault'), undefined, gEnv);
      const out = `${r.stdout}${r.stderr}`;

      // Exactly 1, not "non-zero": status is null when the process never started,
      // which would satisfy a !== 0 check while proving nothing about the abort.
      assert(r.status === 1, `expected exit 1, got ${r.status ?? 'null'}\n${out.slice(0, 500)}`);
      assert(out.includes(missing), `expected the path in the message, got: ${out.slice(0, 500)}`);
      assert(!out.includes('ENOENT'), `raw Node error leaked to the operator: ${out.slice(0, 500)}`);
    }),
  );

  return { name: 'Suite G - Cache & Clear', tests };
}
