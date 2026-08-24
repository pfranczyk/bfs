import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';

// --- Suite A - CLI bootstrap --------------------------------------------------

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
    await runTest('A2b', 'bfs --version', () => {
      // A bare --version never reaches Commander: the dispatcher in
      // src/index.ts answers it, because registering the long form on the
      // program would take it away from the subcommands that use --version as
      // their own argument. This pins the flag the operator actually types.
      const r = runBfs(['--version'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}, expected 0`);
      const out = r.stdout + r.stderr;
      assert(/\d+\.\d+\.\d+/.test(out), `version not found in: ${out.slice(0, 100)}`);
      assert(!/unknown option/i.test(out), `--version must be a known option: ${out.slice(0, 100)}`);
    }),
  );

  tests.push(
    await runTest('A2c', '--version typed at the REPL prompt', () => {
      // REPL tokens go straight to Commander, which knows only the short -V, so
      // the prompt needs the same answer the command line gives. Running bfs
      // with no sub-command opens the prompt; piped stdin drives one line and
      // EOF closes it.
      const r = runBfs([], vaultDir, '--version\n');
      const out = r.stdout + r.stderr;
      assert(/\d+\.\d+\.\d+/.test(out), `version not found in REPL output: ${out.slice(0, 300)}`);
      assert(!/unknown option/i.test(out), `the prompt must not reject --version: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('A3', 'bfs <unknown command> -> non-zero exit', () => {
      const r = runBfs(['unknown-command'], vaultDir);
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

  // -- CI-mode validation: regression for silent null-scheme config ---------
  // bfs init --ci must refuse incomplete arg sets instead of emitting a config
  // with scheme.data_shards=null that crashes push later.

  tests.push(
    await runTest('A6', 'bfs init --ci without vault_name -> abort', async () => {
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
    await runTest('A7', 'bfs init --ci <name> without --data-shards -> abort', async () => {
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
    await runTest('A8', 'bfs init --ci with --data-shards 1 (too few) -> abort', async () => {
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
    await runTest('A9', 'bfs init --ci with insufficient --provider count -> abort', async () => {
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

  // -- Duplicate provider id rejection --------------------------------------
  // bfs init --ci rejects two --provider specs that share an id; a duplicate
  // would otherwise land in config.json and break push later. Guards exit!=0
  // and that no config is written.

  tests.push(
    await runTest('A10', 'bfs init --ci with duplicate --provider id -> abort', async () => {
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

  // -- Vault name path-traversal rejection ----------------------------------
  // A vault name becomes a path segment under each provider's base path
  // ({base}/{vault_name}/shard_...). init must reject names containing path
  // separators or '..' so a name like '../evil' or 'a/b' cannot write shards
  // outside the configured base. Guards exit!=0 AND that no traversal/separator
  // directory materialises on disk. Does NOT assert the exact i18n message -
  // only exit code and the absence of a side-effect.

  tests.push(
    await runTest('A11', 'bfs init --ci --name "../evil" -> abort, no traversal dir', async () => {
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
    await runTest('A12', 'bfs init --ci --name "a/b" -> abort, no nested dir', async () => {
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

  // -- Foreign-vault collision rejection (P1-C) -----------------------------
  // init must refuse a target location that already holds a DIFFERENT backup of
  // the same name (foreign vault_id). Machine A owns "docs"; machine B then
  // inits "docs" at the same media. Guards exit!=0, the user-facing collision
  // message (EN or PL), and that B's config is not written.

  tests.push(
    await runTest('A13', 'bfs init onto a location holding a foreign backup -> abort', async () => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-collision-'));
      const srcA = path.join(base, 'A');
      const srcB = path.join(base, 'B');
      const d0 = path.join(base, 'm0');
      const d1 = path.join(base, 'm1');
      const d2 = path.join(base, 'm2');
      try {
        await fs.mkdir(srcA);
        await fs.mkdir(srcB);
        await fs.writeFile(path.join(srcA, 'f.txt'), 'hello');

        const media = ['--provider', `local:a0 --path ${d0}`, '--provider', `local:a1 --path ${d1}`, '--provider', `local:a2 --path ${d2}`];
        const initArgs = ['init', 'docs', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media];

        const ra = runBfs(initArgs, srcA);
        assert(ra.status === 0, `machine A init should succeed, got exit ${ra.status ?? 'null'}: ${(ra.stdout + ra.stderr).slice(0, 200)}`);
        const rp = runBfs(['push', '--new'], srcA);
        assert(rp.status === 0, `machine A push should succeed, got exit ${rp.status ?? 'null'}: ${(rp.stdout + rp.stderr).slice(0, 200)}`);

        const rb = runBfs(initArgs, srcB);
        assert(rb.status !== 0, `machine B init should abort on collision, got exit ${rb.status ?? 'null'}`);
        const out = rb.stdout + rb.stderr;
        assert(out.includes('already holds a different backup') || out.includes('istnieje już inna kopia'), `expected collision message, got: ${out.slice(0, 300)}`);

        const cfgExists = await fs
          .stat(path.join(srcB, '.bfs', 'config.json'))
          .then(() => true)
          .catch(() => false);
        assert(!cfgExists, 'machine B config.json must NOT be written when the location holds another backup');
      } finally {
        await fs.rm(base, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // -- `--ci` belongs to BFS core, wherever it is typed ---------------------
  // The flag declares the mode of the whole run, so core collects it from the
  // command line regardless of position and no command or adapter consumes it.
  // Only a token of the BFS command line counts: `--ci` inside a quoted spec
  // (`--provider "local:p1 --path x --ci"`) is the adapter's text, not ours.

  tests.push(
    await runTest('A14', "bfs push --ci - the flag is core's wherever it stands", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-pos-'));
      try {
        const r = runBfs(['push', '--ci'], dir);
        const out = r.stdout + r.stderr;
        assert(!/unknown option/i.test(out), `--ci after a sub-command must reach core, not be rejected: ${out.slice(0, 200)}`);
        // The run is refused for the honest reason: there is no backup here.
        assert(/no backup|Nie znaleziono kopii/i.test(out), `expected the missing-backup refusal, got: ${out.slice(0, 200)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A15', 'bfs prune --keep-last 999 --yes --ci - trailing position', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-tail-'));
      try {
        const r = runBfs(['prune', '--keep-last', '999', '--yes', '--ci'], dir);
        const out = r.stdout + r.stderr;
        assert(!/unknown option/i.test(out), `a trailing --ci must reach core: ${out.slice(0, 200)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  tests.push(
    await runTest('A16', 'bfs init with --ci typed after the sub-command flags', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-init-'));
      try {
        // Positive control for position independence: the same init that
        // succeeds with a leading --ci must succeed with a trailing one.
        const media = ['--provider', `local:p1 --path ${path.join(dir, 'm1')}`, '--provider', `local:p2 --path ${path.join(dir, 'm2')}`, '--provider', `local:p3 --path ${path.join(dir, 'm3')}`];
        const r = runBfs(['init', 'docs', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media, '--ci'], dir);
        const out = r.stdout + r.stderr;
        assert(r.status === 0, `trailing --ci must declare the mode, got exit ${r.status ?? 'null'}: ${out.slice(0, 300)}`);
        const cfgExists = await fs
          .stat(path.join(dir, '.bfs', 'config.json'))
          .then(() => true)
          .catch(() => false);
        assert(cfgExists, 'init with a trailing --ci must write the configuration');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // -- An incomplete `--ci` command line is an error, never a question -------
  // The promise `--ci` makes is that nothing will be asked. Where a command
  // still needs a decision, the missing piece is a fault of the invocation, so
  // the run must refuse and name the flag that carries the decision.
  //
  // What this pins is the ORDER and the wording: the backup below holds no
  // versions, so `prune` would reach `prune_no_versions` before any prompt, and
  // the refusal has to arrive ahead of both. That a run WITH versions stops dead
  // on the question instead is a different observation, and it needs a terminal -
  // scripts/cli-e2e/scenarios/113-ci-never-prompts carries it.

  tests.push(
    await runTest('A17', 'bfs --ci prune / provider remove - incomplete command line refused', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-guard-'));
      try {
        const media = ['--provider', `local:p1 --path ${path.join(dir, 'm1')}`, '--provider', `local:p2 --path ${path.join(dir, 'm2')}`, '--provider', `local:p3 --path ${path.join(dir, 'm3')}`];
        const init = runBfs(['init', 'guarded', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media], dir);
        assert(init.status === 0, `setup init failed: ${(init.stdout + init.stderr).slice(0, 300)}`);

        // The backup holds no versions on purpose: the refusal has to come from
        // the command line being incomplete, not from there being nothing to
        // delete, so it must arrive before the versions are even read.
        const noRange = runBfs(['--ci', 'prune'], dir);
        const noRangeOut = noRange.stdout + noRange.stderr;
        assert(noRange.status === 1, `prune --ci with nothing named must exit 1, got ${noRange.status ?? 'null'}: ${noRangeOut.slice(0, 300)}`);
        assert(noRangeOut.includes('--keep-last'), `the refusal must name how to pick versions: ${noRangeOut.slice(0, 300)}`);

        const noYes = runBfs(['--ci', 'prune', '1'], dir);
        const noYesOut = noYes.stdout + noYes.stderr;
        assert(noYes.status === 1, `prune --ci without consent must exit 1, got ${noYes.status ?? 'null'}: ${noYesOut.slice(0, 300)}`);
        assert(noYesOut.includes('--yes'), `the refusal must name how to give consent: ${noYesOut.slice(0, 300)}`);

        const noYesKeepLast = runBfs(['--ci', 'prune', '--keep-last', '1'], dir);
        const noYesKeepLastOut = noYesKeepLast.stdout + noYesKeepLast.stderr;
        assert(noYesKeepLast.status === 1, `prune --ci --keep-last without consent must exit 1, got ${noYesKeepLast.status ?? 'null'}: ${noYesKeepLastOut.slice(0, 300)}`);
        assert(noYesKeepLastOut.includes('--yes'), `the refusal must name how to give consent: ${noYesKeepLastOut.slice(0, 300)}`);

        const noId = runBfs(['--ci', 'provider', 'remove'], dir);
        const noIdOut = noId.stdout + noId.stderr;
        assert(noId.status === 1, `provider remove --ci with no name must exit 1, got ${noId.status ?? 'null'}: ${noIdOut.slice(0, 300)}`);

        const noStrategy = runBfs(['--ci', 'provider', 'remove', 'p1'], dir);
        const noStrategyOut = noStrategy.stdout + noStrategy.stderr;
        assert(noStrategy.status === 1, `provider remove --ci without a strategy must exit 1, got ${noStrategy.status ?? 'null'}: ${noStrategyOut.slice(0, 300)}`);
        assert(noStrategyOut.includes('--strategy'), `the refusal must name the decision flag: ${noStrategyOut.slice(0, 300)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // -- A question nobody can answer is not a cancellation --------------------
  // Below the CLI the mode arrives as ProviderIO.interactive, and a yes/no there
  // answers itself with "no". Reporting that as the operator's cancellation is
  // untrue and, worse, dead-ends: the same command run again ends the same way.
  // `pull` has the flags that settle it, so the refusal has to name one.

  tests.push(
    await runTest('A18', 'bfs --ci pull - an unconfirmable overwrite names --yes, in both languages', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-ci-pull-'));
      try {
        // --lang persists the choice in the global settings file, so both runs
        // get a config home of their own and leave the rest of the suite alone.
        const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'lang-config') };
        const media = ['--provider', `local:p1 --path ${path.join(dir, 'm1')}`, '--provider', `local:p2 --path ${path.join(dir, 'm2')}`, '--provider', `local:p3 --path ${path.join(dir, 'm3')}`];
        await fs.writeFile(path.join(dir, 'note.txt'), 'pull guard fixture', 'utf-8');
        const init = runBfs(['init', 'pulled', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media], dir);
        assert(init.status === 0, `setup init failed: ${(init.stdout + init.stderr).slice(0, 300)}`);
        const pushed = runBfs(['push', '--new'], dir);
        assert(pushed.status === 0, `setup push failed: ${(pushed.stdout + pushed.stderr).slice(0, 300)}`);

        const en = runBfs(['--lang', 'en', '--ci', 'pull'], dir, undefined, langEnv);
        const enOut = en.stdout + en.stderr;
        assert(en.status !== 0, `pull --ci without consent must not report success, got ${en.status ?? 'null'}: ${enOut.slice(0, 300)}`);
        assert(enOut.includes('--yes'), `the refusal must name how to give consent: ${enOut.slice(0, 300)}`);
        assert(!/cancell?ed/i.test(enOut), `nobody was asked, so nothing was cancelled: ${enOut.slice(0, 300)}`);
        // --force also gets past this gate, but it empties the working directory
        // of everything the backup does not carry - not what consent to an
        // overwrite means. Naming it here would be handing over a deletion.
        assert(!enOut.includes('--force'), `--force is not an equivalent of --yes and must not be offered: ${enOut.slice(0, 300)}`);

        const pl = runBfs(['--lang', 'pl', '--ci', 'pull'], dir, undefined, langEnv);
        const plOut = pl.stdout + pl.stderr;
        assert(pl.status !== 0, `pull --ci without consent must not report success (PL), got ${pl.status ?? 'null'}: ${plOut.slice(0, 300)}`);
        assert(plOut.includes('--yes'), `the Polish refusal must name how to give consent: ${plOut.slice(0, 300)}`);
        assert(!/anulowan/i.test(plOut), `nobody was asked, so nothing was cancelled (PL): ${plOut.slice(0, 300)}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  // -- A directory that already holds a backup is not a place to init --------
  // Re-initializing here mints a fresh vault_id and resets the version history,
  // while the shards on the media keep the old one - the directory stops
  // reaching data it has versions for. The collision guard (A13) does not cover
  // it: that one reads the media under the NEW name's sub-directory, which is
  // empty whenever the operator supplies a different name. Guards exit!=0, that
  // the refusal names the backup standing in the way, and that the existing
  // configuration survives - in both languages.

  tests.push(
    await runTest('A19', 'bfs init in a directory that already holds a backup -> abort, config intact', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-smoke-init-existing-'));
      try {
        const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'lang-config') };
        const media = ['--provider', `local:p1 --path ${path.join(dir, 'm1')}`, '--provider', `local:p2 --path ${path.join(dir, 'm2')}`, '--provider', `local:p3 --path ${path.join(dir, 'm3')}`];
        await fs.writeFile(path.join(dir, 'note.txt'), 'init guard fixture', 'utf-8');
        const first = runBfs(['init', 'docs', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media], dir);
        assert(first.status === 0, `setup init failed: ${(first.stdout + first.stderr).slice(0, 300)}`);
        const cfgPath = path.join(dir, '.bfs', 'config.json');
        const before = await fs.readFile(cfgPath, 'utf-8');

        // A different name - the input that walks past the medium-side guard.
        const second = ['init', 'photos', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', ...media];

        const en = runBfs(['--lang', 'en', ...second], dir, undefined, langEnv);
        const enOut = en.stdout + en.stderr;
        assert(en.status !== 0, `init over an existing backup must abort, got ${en.status ?? 'null'}: ${enOut.slice(0, 300)}`);
        assert(enOut.includes('docs'), `the refusal must name the backup already here: ${enOut.slice(0, 300)}`);
        // `bfs clear` removes cache and locks - never config.json - so sending
        // the operator there would leave them exactly where they started.
        assert(!/bfs clear/.test(enOut), `\`bfs clear\` does not remove a configuration and must not be offered: ${enOut.slice(0, 300)}`);

        const pl = runBfs(['--lang', 'pl', ...second], dir, undefined, langEnv);
        const plOut = pl.stdout + pl.stderr;
        assert(pl.status !== 0, `init over an existing backup must abort (PL), got ${pl.status ?? 'null'}: ${plOut.slice(0, 300)}`);
        assert(plOut.includes('docs'), `the Polish refusal must name the backup already here: ${plOut.slice(0, 300)}`);
        assert(!/bfs clear/.test(plOut), `\`bfs clear\` must not be offered (PL): ${plOut.slice(0, 300)}`);
        // Without this the Polish branch would be satisfied by the English text
        // verbatim, since the only other things it looks for are a backup name
        // and the absence of a command.
        assert(/katalog/i.test(plOut), `the Polish refusal must actually be in Polish: ${plOut.slice(0, 300)}`);

        assert((await fs.readFile(cfgPath, 'utf-8')) === before, 'the existing configuration must survive a refused init byte-for-byte');
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }),
  );

  return { name: 'Suite A - CLI bootstrap', tests };
}
