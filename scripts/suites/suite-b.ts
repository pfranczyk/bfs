import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest, skipTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { buildInitArgs, fileExists, readJson } from '../smoke-vault.js';

// --- Suite B - CLI init (subprocess) -----------------------------------------

/**
 * Tests `bfs init <name>` as a subprocess with piped stdin.
 * Goal: catch regressions in CLI init argument parsing (e.g. --name -> positional arg change).
 * Uses a separate directory from the main ctx - does not interfere with Suite C/D/E.
 *
 * CI flags bypass interactive Inquirer prompts (--no-enc, --data-shards,
 * --parity-shards, --provider, --push-mode), making the test deterministic
 * and TTY-free in any environment.
 */
export async function suiteB(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const cliVaultDir = path.join(ctx.sourceDir, 'cli-vault');
  const cliP1Dir = path.join(ctx.sourceDir, 'cli-p1');
  const cliP2Dir = path.join(ctx.sourceDir, 'cli-p2');
  const cliP3Dir = path.join(ctx.sourceDir, 'cli-p3');

  // Every `bfs` run carrying `--lang` gets this config home: the flag persists
  // the choice in the global settings file, so without it the suite would set the
  // language for the whole process - and Suite B runs first, which would leave
  // every later suite reading output in a language it never asked for.
  const langDir = path.join(ctx.sourceDir, 'b-lang-config');
  const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: langDir };

  tests.push(
    await runTest('B0', 'setup: directories for CLI init', async () => {
      await fs.mkdir(cliVaultDir, { recursive: true });
      await fs.mkdir(cliP1Dir, { recursive: true });
      await fs.mkdir(cliP2Dir, { recursive: true });
      await fs.mkdir(cliP3Dir, { recursive: true });
      await fs.writeFile(path.join(cliVaultDir, 'cli-test.txt'), 'CLI init smoke test');
    }),
  );

  const ciInitArgs = buildInitArgs(
    'cli-vault',
    [
      { id: 'cli-p1', dir: cliP1Dir },
      { id: 'cli-p2', dir: cliP2Dir },
      { id: 'cli-p3', dir: cliP3Dir },
    ],
    ['--push-mode', 'new_version', '--no-enc'],
  );

  tests.push(
    await runTest('B1', 'bfs init <name> - positional argument + CI flags', () => {
      const r = runBfs(ciInitArgs, cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B1b', '.bfsignore exists after bfs init', async () => {
      assert(await fileExists(path.join(cliVaultDir, '.bfsignore')), `.bfsignore missing after bfs init`);
    }),
  );

  tests.push(
    await runTest('B2', '.bfs/config.json exists after init', async () => {
      assert(await fileExists(path.join(cliVaultDir, '.bfs', 'config.json')), `.bfs/config.json missing after bfs init`);
    }),
  );

  tests.push(
    await runTest('B2c', 'init --ci --no-enc -> encryption.enabled=false in config', async () => {
      const cfg = await readJson<{ encryption?: { enabled: boolean } }>(path.join(cliVaultDir, '.bfs', 'config.json'));
      assert(cfg.encryption?.enabled === false, `expected encryption.enabled=false with --no-enc, got: ${JSON.stringify(cfg.encryption)}`);
    }),
  );

  // -- Encryption default-ON (no flag) vs opt-out ------------------------------
  tests.push(
    await runTest('B2d', 'init --ci (no flag) -> encryption.enabled=true by default', async () => {
      const encVaultDir = path.join(ctx.sourceDir, 'enc-default-vault');
      const e1 = path.join(ctx.sourceDir, 'enc-p1');
      const e2 = path.join(ctx.sourceDir, 'enc-p2');
      const e3 = path.join(ctx.sourceDir, 'enc-p3');
      await Promise.all([encVaultDir, e1, e2, e3].map((d) => fs.mkdir(d, { recursive: true })));
      await fs.writeFile(path.join(encVaultDir, 'enc-test.txt'), 'encryption default smoke test');
      const r = runBfs(
        buildInitArgs('enc-default-vault', [
          { id: 'enc-p1', dir: e1 },
          { id: 'enc-p2', dir: e2 },
          { id: 'enc-p3', dir: e3 },
        ]),
        encVaultDir,
      );
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const cfg = await readJson<{ encryption?: { enabled: boolean } }>(path.join(encVaultDir, '.bfs', 'config.json'));
      assert(cfg.encryption?.enabled === true, `expected encryption.enabled=true by default, got: ${JSON.stringify(cfg.encryption)}`);
    }),
  );

  tests.push(
    await runTest('B2e', 'init --ci --no-enc -> unencrypted backup warning (EN)', async () => {
      const v = path.join(ctx.sourceDir, 'warn-en-vault');
      const w1 = path.join(ctx.sourceDir, 'warn-en-p1');
      const w2 = path.join(ctx.sourceDir, 'warn-en-p2');
      const w3 = path.join(ctx.sourceDir, 'warn-en-p3');
      await Promise.all([v, w1, w2, w3].map((d) => fs.mkdir(d, { recursive: true })));
      await fs.writeFile(path.join(v, 'warn-test.txt'), 'unencrypted warning smoke test');
      const r = runBfs(
        [
          '--lang',
          'en',
          ...buildInitArgs(
            'warn-en-vault',
            [
              { id: 'warn-en-p1', dir: w1 },
              { id: 'warn-en-p2', dir: w2 },
              { id: 'warn-en-p3', dir: w3 },
            ],
            ['--no-enc'],
          ),
        ],
        v,
        undefined,
        langEnv,
      );
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/NOT encrypted/.test(out), `expected English unencrypted warning in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B2f', 'init --ci --no-enc -> unencrypted backup warning (PL)', async () => {
      const v = path.join(ctx.sourceDir, 'warn-pl-vault');
      const w1 = path.join(ctx.sourceDir, 'warn-pl-p1');
      const w2 = path.join(ctx.sourceDir, 'warn-pl-p2');
      const w3 = path.join(ctx.sourceDir, 'warn-pl-p3');
      await Promise.all([v, w1, w2, w3].map((d) => fs.mkdir(d, { recursive: true })));
      await fs.writeFile(path.join(v, 'warn-test.txt'), 'unencrypted warning smoke test');
      const r = runBfs(
        [
          '--lang',
          'pl',
          ...buildInitArgs(
            'warn-pl-vault',
            [
              { id: 'warn-pl-p1', dir: w1 },
              { id: 'warn-pl-p2', dir: w2 },
              { id: 'warn-pl-p3', dir: w3 },
            ],
            ['--no-enc'],
          ),
        ],
        v,
        undefined,
        langEnv,
      );
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/nie jest zaszyfrowana/i.test(out), `expected Polish unencrypted warning in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B3', 'bfs status after CLI init', () => {
      const r = runBfs(['status'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B4', 'bfs push after CLI init', () => {
      const r = runBfs(['push'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B5', 'bfs verify after CLI init + push', () => {
      const r = runBfs(['verify'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/healthy|zdrow/i.test(out), `expected healthy in: ${out.slice(0, 200)}`);
    }),
  );

  // -- provider add --ci ------------------------------------------------------
  const cliP4Dir = path.join(ctx.sourceDir, 'cli-p4');

  tests.push(
    await runTest('B6', 'setup: cli-p4 directory', async () => {
      await fs.mkdir(cliP4Dir, { recursive: true });
    }),
  );

  tests.push(
    await runTest('B7', 'bfs provider add --ci (new provider)', async () => {
      // The minimal pass-through CLI (`bfs provider add --ci`) accepts only
      // --name, --type, and an optional --config-file. Provider-specific
      // details (like the local path) live inside the JSON config file.
      const configFile = path.join(ctx.sourceDir, 'cli-p4-config.json');
      await fs.writeFile(configFile, JSON.stringify({ path: cliP4Dir }), 'utf8');
      const r = runBfs(['provider', 'add', '--ci', '--name', 'cli-p4', '--type', 'local', '--config-file', configFile], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('cli-p4'), `expected cli-p4 in output: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('B8', 'bfs provider list - cli-p4 visible', () => {
      const r = runBfs(['provider', 'list'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('cli-p4'), `expected cli-p4 in provider list: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('B8b', 'bfs provider --help lists the built-in ssh type', () => {
      const r = runBfs(['provider', '--help'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('SSH/SFTP'), `expected SSH/SFTP provider in help: ${out.slice(0, 400)}`);
      assert(/--type\s+ssh\b/.test(out), `expected '--type ssh' example in help: ${out.slice(0, 400)}`);
    }),
  );

  // -- provider remove --strategy remove --yes --------------------------------

  tests.push(
    await runTest('B9', 'bfs provider remove --strategy remove --yes', () => {
      const r = runBfs(['provider', 'remove', 'cli-p4', '--strategy', 'remove', '--yes'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B10', 'bfs provider list - cli-p4 removed', () => {
      const r = runBfs(['provider', 'list'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(!out.includes('cli-p4'), `cli-p4 still visible after removal: ${out.slice(0, 300)}`);
    }),
  );

  // -- provider remove --strategy remove: the recommended next steps ----------
  // Dropping a storage leaves the backup with fewer storages than its scheme
  // declares, and every command the removal recommends - `bfs pull`, `bfs push`,
  // `bfs prune` - passes through the same scheme check, so all three refuse to
  // run until the scheme matches the storages that are left. `bfs scheme set` is
  // what unblocks them, which is why it has to lead the list; `bfs provider add`
  // cannot, because it raises parity by one and so widens the very mismatch it
  // would have to close.
  //
  // Each test runs the real CLI in two parts. First the reality proof: the three
  // recommended commands are blocked, then `bfs scheme set` with numbers that fit
  // the remaining storages makes `bfs pull` work - evidence that the way out
  // exists and starts where the list should point. Then the contract: the printed
  // list names those steps in that order.

  tests.push(
    await runTest('B10a', 'provider remove --strategy remove - recommended steps are ordered and actionable (EN)', async () => {
      const vaultDir = await initVaultForRemoval(ctx.sourceDir, 'rm-en', langEnv);
      const rr = runBfs(['--lang', 'en', 'provider', 'remove', 'rm-en-p4', '--strategy', 'remove', '--yes'], vaultDir, undefined, langEnv);
      assert(rr.status === 0, `remove exit ${rr.status ?? 'null'}\nstdout: ${rr.stdout}\nstderr: ${rr.stderr}`);
      const steps = rr.stdout + rr.stderr;

      // Reality, part 1 - every recommended command is dead until the scheme is fixed.
      for (const { label, args } of RECOMMENDED_AFTER_REMOVAL) {
        const rb = runBfs(['--lang', 'en', ...args], vaultDir, undefined, langEnv);
        const blockedOut = rb.stdout + rb.stderr;
        assert(rb.status !== 0, `expected \`${label}\` to fail after removal, got exit ${rb.status ?? 'null'}\n${blockedOut.slice(0, 400)}`);
        assert(blockedOut.includes('Scheme requires 4 providers, configured: 3'), `expected provider-count mismatch from \`${label}\`: ${blockedOut.slice(0, 400)}`);
        assert(blockedOut.includes('Match the scheme to the storages you have with `bfs scheme set <N> <K>`.'), `expected \`bfs scheme set <N> <K>\` as the way out of the mismatch from \`${label}\`: ${blockedOut.slice(0, 400)}`);
        assert(!blockedOut.includes('bfs provider add'), `\`bfs provider add\` raises the required provider count together with the pool, so it never closes this gap and must not be advised by \`${label}\`: ${blockedOut.slice(0, 400)}`);
      }

      // Reality, part 2 - `bfs scheme set` is the step that opens the road.
      const rs = runBfs(['--lang', 'en', 'scheme', 'set', '2', '1'], vaultDir, undefined, langEnv);
      assert(rs.status === 0, `\`bfs scheme set 2 1\` exit ${rs.status ?? 'null'}\nstdout: ${rs.stdout}\nstderr: ${rs.stderr}`);
      const rl = runBfs(['--lang', 'en', 'pull', '--force'], vaultDir, undefined, langEnv);
      assert(rl.status === 0, `expected \`bfs pull\` to work after \`bfs scheme set 2 1\`, got exit ${rl.status ?? 'null'}\nstdout: ${rl.stdout}\nstderr: ${rl.stderr}`);

      // Contract - the printed list leads down that same road, in that order.
      assert(/1\.\s*`bfs scheme set/.test(steps), `expected step 1 to be \`bfs scheme set\` in: ${steps.slice(0, 600)}`);
      assert(/2\.\s*`bfs pull`/.test(steps), `expected step 2 to be \`bfs pull\` in: ${steps.slice(0, 600)}`);
      assert(/3\.\s*`bfs push`/.test(steps), `expected step 3 to be \`bfs push\` in: ${steps.slice(0, 600)}`);
      assert(/4\.\s*`bfs prune`/.test(steps), `expected step 4 to be \`bfs prune\` in: ${steps.slice(0, 600)}`);
    }),
  );

  tests.push(
    await runTest('B10b', 'provider remove --strategy remove - recommended steps are ordered and actionable (PL)', async () => {
      const vaultDir = await initVaultForRemoval(ctx.sourceDir, 'rm-pl', langEnv);
      const rr = runBfs(['--lang', 'pl', 'provider', 'remove', 'rm-pl-p4', '--strategy', 'remove', '--yes'], vaultDir, undefined, langEnv);
      assert(rr.status === 0, `remove exit ${rr.status ?? 'null'}\nstdout: ${rr.stdout}\nstderr: ${rr.stderr}`);
      const steps = rr.stdout + rr.stderr;

      for (const { label, args } of RECOMMENDED_AFTER_REMOVAL) {
        const rb = runBfs(['--lang', 'pl', ...args], vaultDir, undefined, langEnv);
        const blockedOut = rb.stdout + rb.stderr;
        assert(rb.status !== 0, `expected \`${label}\` to fail after removal, got exit ${rb.status ?? 'null'}\n${blockedOut.slice(0, 400)}`);
        assert(blockedOut.includes('Schemat wymaga 4 nośników, skonfigurowano: 3'), `expected provider-count mismatch from \`${label}\`: ${blockedOut.slice(0, 400)}`);
        assert(blockedOut.includes('Dopasuj schemat do posiadanych nośników przez `bfs scheme set <N> <K>`.'), `expected \`bfs scheme set <N> <K>\` as the way out of the mismatch from \`${label}\`: ${blockedOut.slice(0, 400)}`);
        assert(!blockedOut.includes('bfs provider add'), `\`bfs provider add\` raises the required provider count together with the pool, so it never closes this gap and must not be advised by \`${label}\`: ${blockedOut.slice(0, 400)}`);
      }

      const rs = runBfs(['--lang', 'pl', 'scheme', 'set', '2', '1'], vaultDir, undefined, langEnv);
      assert(rs.status === 0, `\`bfs scheme set 2 1\` exit ${rs.status ?? 'null'}\nstdout: ${rs.stdout}\nstderr: ${rs.stderr}`);
      const rl = runBfs(['--lang', 'pl', 'pull', '--force'], vaultDir, undefined, langEnv);
      assert(rl.status === 0, `expected \`bfs pull\` to work after \`bfs scheme set 2 1\`, got exit ${rl.status ?? 'null'}\nstdout: ${rl.stdout}\nstderr: ${rl.stderr}`);

      assert(/1\.\s*`bfs scheme set/.test(steps), `expected step 1 to be \`bfs scheme set\` in: ${steps.slice(0, 600)}`);
      assert(/2\.\s*`bfs pull`/.test(steps), `expected step 2 to be \`bfs pull\` in: ${steps.slice(0, 600)}`);
      assert(/3\.\s*`bfs push`/.test(steps), `expected step 3 to be \`bfs push\` in: ${steps.slice(0, 600)}`);
      assert(/4\.\s*`bfs prune`/.test(steps), `expected step 4 to be \`bfs prune\` in: ${steps.slice(0, 600)}`);
    }),
  );

  // -- provider remove: what the [R]emove strategy promises -------------------
  // The strategy list is an Inquirer rawlist, but it is written to stdout before
  // the closed stdin cancels the prompt, so the wording is observable without a
  // terminal. Dropping a storage leaves the scheme untouched, so the [R]emove
  // entry has to send the operator to `bfs scheme set` instead of claiming the
  // N/K scheme follows along by itself. Inquirer hard-wraps a piped stdout at 80
  // columns and the break lands mid-word, hence the whitespace-collapsed compare.

  tests.push(
    await runTest('B10c', 'provider remove - [R]emove strategy sends the operator to `bfs scheme set` (EN)', () => {
      const r = runBfs(['--lang', 'en', 'provider', 'remove', 'cli-p1'], cliVaultDir, '', langEnv);
      const listed = collapseWhitespace(r.stdout + r.stderr);
      assert(listed.includes('[R]emove-removeproviderwithoutreplacement(matchtheN/Kschemeafterwardswith`bfsschemeset`)'), `expected the [R]emove strategy to point at \`bfs scheme set\`: ${(r.stdout + r.stderr).slice(0, 800)}`);
      assert(!listed.includes('withoutreplacement,updateN/Kscheme'), `removal leaves the scheme untouched, so [R]emove must not promise to update it: ${(r.stdout + r.stderr).slice(0, 800)}`);
    }),
  );

  tests.push(
    await runTest('B10d', 'provider remove - [R]emove strategy sends the operator to `bfs scheme set` (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'provider', 'remove', 'cli-p1'], cliVaultDir, '', langEnv);
      const listed = collapseWhitespace(r.stdout + r.stderr);
      assert(listed.includes('[R]emove-usuńnośnikbezzastępstwa(schematN/Kdopasujpotemprzez`bfsschemeset`)'), `expected the [R]emove strategy to point at \`bfs scheme set\`: ${(r.stdout + r.stderr).slice(0, 800)}`);
      assert(!listed.includes('bezzastępstwa,zaktualizujschematN/K'), `removal leaves the scheme untouched, so [R]emove must not promise to update it: ${(r.stdout + r.stderr).slice(0, 800)}`);
    }),
  );

  // -- a scheme that cannot be used at all ------------------------------------
  // A data_shards below the format minimum can only reach the config by hand,
  // and no command can run with it. `bfs provider add` cannot repair it either -
  // it grows the pool and the required total together - so the message has one
  // way out to offer, `bfs scheme set`. `bfs push` validates the scheme before it
  // reads a single file, so an unpushed vault is enough to reach the message.

  tests.push(
    await runTest('B10e', 'unusable data_shards - the fix offered is `bfs scheme set` alone (EN)', async () => {
      const vaultDir = await initVaultWithBrokenScheme(ctx.sourceDir, 'bs-en', langEnv);
      const r = runBfs(['--lang', 'en', 'push'], vaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected \`bfs push\` to refuse an unusable scheme, got exit ${r.status ?? 'null'}\n${out.slice(0, 400)}`);
      assert(out.includes('Invalid scheme: data_shards must be an integer >= 2, got "1"'), `expected the invalid-scheme message in: ${out.slice(0, 400)}`);
      assert(out.includes('Use `bfs scheme set <N> <K>` to fix.'), `expected \`bfs scheme set <N> <K>\` as the fix in: ${out.slice(0, 400)}`);
      assert(!out.includes('bfs provider add'), `\`bfs provider add\` cannot bring data_shards back above the minimum and must not be advised: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B10f', 'unusable data_shards - the fix offered is `bfs scheme set` alone (PL)', async () => {
      const vaultDir = await initVaultWithBrokenScheme(ctx.sourceDir, 'bs-pl', langEnv);
      const r = runBfs(['--lang', 'pl', 'push'], vaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected \`bfs push\` to refuse an unusable scheme, got exit ${r.status ?? 'null'}\n${out.slice(0, 400)}`);
      assert(out.includes('Nieprawidłowy schemat: data_shards musi być liczbą całkowitą >= 2, podano "1"'), `expected the invalid-scheme message in: ${out.slice(0, 400)}`);
      assert(out.includes('Użyj `bfs scheme set <N> <K>`, aby naprawić.'), `expected \`bfs scheme set <N> <K>\` as the fix in: ${out.slice(0, 400)}`);
      assert(!out.includes('bfs provider add'), `\`bfs provider add\` cannot bring data_shards back above the minimum and must not be advised: ${out.slice(0, 400)}`);
    }),
  );

  // -- init --ci --provider pass-through grammar ----------------------------
  // type:name + shell-style flags. Credentials live in JSON files, not argv.

  const ptVaultDir = path.join(ctx.sourceDir, 'cli-pt-vault');
  const ptDirs = [path.join(ctx.sourceDir, 'cli-pt-p1'), path.join(ctx.sourceDir, 'cli-pt-p2'), path.join(ctx.sourceDir, 'cli-pt-p3')];
  // The runs that check how a bad command line is reported need a directory with
  // the same fixture files but NO backup in it. `bfs init` settles the state of
  // the working directory before it looks at the command line - rightly, since a
  // corrected command line would be refused there anyway - so sharing the
  // directory B12 initializes would answer each of them with the re-init refusal
  // instead of the message under test.
  const argVaultDir = path.join(ctx.sourceDir, 'cli-arg-vault');

  tests.push(
    await runTest('B11', 'setup: directories + config files for pass-through', async () => {
      await fs.mkdir(ptVaultDir, { recursive: true });
      await fs.mkdir(argVaultDir, { recursive: true });
      for (const d of ptDirs) await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(ptVaultDir, 'pt-test.txt'), 'pass-through smoke');
      await fs.writeFile(path.join(argVaultDir, 'pt-test.txt'), 'pass-through smoke');
      for (let i = 0; i < ptDirs.length; i++) {
        await fs.writeFile(path.join(ptVaultDir, `p${i + 1}.json`), JSON.stringify({ path: ptDirs[i] }), 'utf8');
        await fs.writeFile(path.join(argVaultDir, `p${i + 1}.json`), JSON.stringify({ path: ptDirs[i] }), 'utf8');
      }
    }),
  );

  tests.push(
    await runTest('B12', 'bfs init --ci --provider "local:id --config-file ..." (pass-through)', () => {
      const r = runBfs(
        [
          'init',
          'cli-pt-vault',
          '--ci',
          '--data-shards',
          '2',
          '--parity-shards',
          '1',
          '--provider',
          'local:pt-p1 --config-file ./p1.json',
          '--provider',
          'local:pt-p2 --config-file ./p2.json',
          '--provider',
          'local:pt-p3 --config-file ./p3.json',
        ],
        ptVaultDir,
      );
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B13', 'config.json after pass-through init has correct id and path', async () => {
      const cfg = JSON.parse(await fs.readFile(path.join(ptVaultDir, '.bfs', 'config.json'), 'utf8')) as { providers: Array<{ id: string; type: string; config: { path: string } }> };
      assert(cfg.providers.length === 3, `expected 3 providers, got ${cfg.providers.length}`);
      assert(cfg.providers[0].id === 'pt-p1' && cfg.providers[0].type === 'local', `bad provider[0]: ${JSON.stringify(cfg.providers[0])}`);
      assert(cfg.providers[0].config.path === ptDirs[0], `path mismatch: ${cfg.providers[0].config.path} vs ${ptDirs[0]}`);
    }),
  );

  tests.push(
    await runTest('B14', 'bfs init --ci rejects provider name with whitespace', () => {
      const r = runBfs(
        [
          'init',
          'cli-pt-bad-vault',
          '--ci',
          '--data-shards',
          '2',
          '--parity-shards',
          '1',
          '--provider',
          "local:'bad name' --config-file ./p1.json",
          '--provider',
          'local:pt-p2 --config-file ./p2.json',
          '--provider',
          'local:pt-p3 --config-file ./p3.json',
        ],
        argVaultDir,
      );
      assert(r.status !== 0, `expected non-zero exit for name with space, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('bad name') || /invalid|dozwolone/i.test(out), `expected provider name validation error in: ${out.slice(0, 300)}`);
    }),
  );

  // B15/B16 regression: a user-reported confusing flow where the FTP error
  // for missing host/path suggested --config-file as if it were a top-level
  // bfs init flag. The error must show the correct shell-quoted spec syntax.
  tests.push(
    await runTest('B15', 'bfs init --ci ftp:nas (no host) shows --provider syntax in error message (EN)', () => {
      const r = runBfs(['--lang', 'en', 'init', 'cli-ftp-bad-vault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:truenas'], argVaultDir, undefined, langEnv);
      assert(r.status !== 0, `expected non-zero exit for missing --host, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--provider "ftp:nas --host'), `expected --provider syntax hint in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B16', 'bfs init --ci ftp:nas (no host) shows --provider syntax in error message (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'init', 'cli-ftp-bad-vault-pl', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:truenas'], argVaultDir, undefined, langEnv);
      assert(r.status !== 0, `expected non-zero exit for missing --host, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('wewnątrz spec --provider'), `expected Polish --provider syntax message in: ${out.slice(0, 400)}`);
    }),
  );

  // B16b/B16c: `--ci` declares that nobody can answer a question, and FTPS is
  // the default - so a spec carrying neither a pinned fingerprint nor
  // --accept-new-cert asks for two incompatible things. The refusal has to name
  // both ways out, in whichever language the operator is running.
  tests.push(
    await runTest('B16b', 'bfs init --ci ftp without a way to trust the server -> refused, names both flags (EN)', () => {
      const r = runBfs(
        ['--lang', 'en', 'init', 'cli-ftp-notrust', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:nas --host 127.0.0.1 --port 2199 --user u --password p --path /backup'],
        argVaultDir,
        undefined,
        langEnv,
      );
      assert(r.status !== 0, `expected non-zero exit for a storage with no basis of trust, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Conflicting instructions'), `expected the conflict to be named in: ${out.slice(0, 400)}`);
      assert(out.includes('--accept-new-cert') && out.includes('--cert-fingerprint'), `expected both ways out in: ${out.slice(0, 400)}`);
      // Decided from the settings - the dead port is never contacted.
      assert(!out.includes('FTP operation failed'), `expected no transport error in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B16c', 'bfs init --ci ftp without a way to trust the server -> refused (PL)', () => {
      const r = runBfs(
        ['--lang', 'pl', 'init', 'cli-ftp-notrust-pl', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:nas --host 127.0.0.1 --port 2199 --user u --password p --path /backup'],
        argVaultDir,
        undefined,
        langEnv,
      );
      assert(r.status !== 0, `expected non-zero exit for a storage with no basis of trust, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Sprzeczne polecenia'), `expected the Polish conflict message in: ${out.slice(0, 400)}`);
      assert(out.includes('--accept-new-cert') && out.includes('--cert-fingerprint'), `expected both ways out in: ${out.slice(0, 400)}`);
    }),
  );

  // -- provider edit --ci (RED: command not implemented yet) ------------------
  // Offline, local-only edit of an existing provider's connection-config.
  // Same id, same type; no medium contact. These assertions are RED until
  // `bfs provider edit` ships in GREEN.
  const cliP5Dir = path.join(ctx.sourceDir, 'cli-p5');
  const cliP5NewDir = path.join(ctx.sourceDir, 'cli-p5-new');

  tests.push(
    await runTest('B17', 'setup: cli-p5 directories + add provider for edit', async () => {
      await fs.mkdir(cliP5Dir, { recursive: true });
      await fs.mkdir(cliP5NewDir, { recursive: true });
      const configFile = path.join(ctx.sourceDir, 'cli-p5-config.json');
      await fs.writeFile(configFile, JSON.stringify({ path: cliP5Dir }), 'utf8');
      const r = runBfs(['provider', 'add', '--ci', '--name', 'cli-p5', '--type', 'local', '--config-file', configFile], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B18', 'bfs provider edit --ci (new path) - exit 0 + id in output', async () => {
      const configFile = path.join(ctx.sourceDir, 'cli-p5-new-config.json');
      await fs.writeFile(configFile, JSON.stringify({ path: cliP5NewDir }), 'utf8');
      const r = runBfs(['provider', 'edit', 'cli-p5', '--ci', '--config-file', configFile], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('cli-p5'), `expected cli-p5 in output: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('B19', 'bfs provider list - cli-p5 shows the new path', () => {
      const r = runBfs(['provider', 'list'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes(cliP5NewDir), `expected new path ${cliP5NewDir} in provider list: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B20', 'bfs provider edit nonexistent id - non-zero exit', () => {
      const configFile = path.join(ctx.sourceDir, 'cli-p5-new-config.json');
      const r = runBfs(['provider', 'edit', 'does-not-exist', '--ci', '--config-file', configFile], cliVaultDir);
      assert(r.status !== 0, `expected non-zero exit for nonexistent provider, got ${r.status}`);
    }),
  );

  // An edit that stops mid-way is reported in the CLI's own voice, whichever
  // storage it was: the marked line, not a bare one that reads like a crash.
  // Reached without `--ci` and with no answer to give, so the adapter's first
  // question has nobody to ask and it refuses - the same route every other stop
  // takes out of the interactive edit.
  tests.push(
    await runTest('B20a', 'bfs provider edit interactive with no operator - marked refusal, config untouched', async () => {
      const configPath = path.join(cliVaultDir, '.bfs', 'config.json');
      const before = await fs.readFile(configPath, 'utf-8');
      const r = runBfs(['--lang', 'en', 'provider', 'edit', 'cli-p5'], cliVaultDir, '', langEnv);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `expected non-zero exit, got ${r.status}\n${out.slice(0, 300)}`);
      // The marker is tied to the reason it belongs to. `X` on its own would
      // also match the refusals this command could always report - a mistyped
      // id, a missing backup - so the test would keep passing on a build that
      // lost this branch entirely.
      assert(/^X .*asks no questions/m.test(out), `expected the refusal to reach the operator marked, got: ${out.slice(0, 300)}`);
      const after = await fs.readFile(configPath, 'utf-8');
      assert(before === after, 'a refused edit must leave the stored configuration untouched');
    }),
  );

  // -- excluded entries (symlinks / special files) ----------------------------
  // push refuses entries that can never be in a backup, listing them and
  // pointing at .bfsignore; --allow-excluded backs up everything else.
  tests.push(
    await runTest('B21', 'bfs push --help lists --allow-excluded (EN)', () => {
      const r = runBfs(['--lang', 'en', 'push', '--help'], cliVaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--allow-excluded'), `expected --allow-excluded flag in help: ${out.slice(0, 500)}`);
      assert(/symbolic links/.test(out), `expected EN --allow-excluded description in help: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('B22', 'bfs push --help shows Polish --allow-excluded description (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'push', '--help'], cliVaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/dowiązaniami symbolicznymi/.test(out), `expected Polish --allow-excluded description in help: ${out.slice(0, 500)}`);
    }),
  );

  // POSIX-only: creating a real symlink needs admin/developer mode on Windows.
  const exclVaultDir = path.join(ctx.sourceDir, 'excl-vault');
  const exclDirs = [path.join(ctx.sourceDir, 'excl-p1'), path.join(ctx.sourceDir, 'excl-p2'), path.join(ctx.sourceDir, 'excl-p3')];
  if (process.platform === 'win32') {
    tests.push(skipTest('B23', 'push aborts (exit 3) on a symlink and names .bfsignore', 'symlinks require admin on Windows'));
    tests.push(skipTest('B24', 'push --allow-excluded backs up the rest (exit 0, healthy)', 'symlinks require admin on Windows'));
  } else {
    tests.push(
      await runTest('B23', 'push aborts (exit 3) on a symlink and names .bfsignore', async () => {
        await fs.mkdir(exclVaultDir, { recursive: true });
        for (const d of exclDirs) await fs.mkdir(d, { recursive: true });
        await fs.writeFile(path.join(exclVaultDir, 'real.txt'), 'excluded smoke test');
        const ri = runBfs(
          buildInitArgs(
            'excl-vault',
            [
              { id: 'excl-p1', dir: exclDirs[0] as string },
              { id: 'excl-p2', dir: exclDirs[1] as string },
              { id: 'excl-p3', dir: exclDirs[2] as string },
            ],
            ['--no-enc'],
          ),
          exclVaultDir,
        );
        assert(ri.status === 0, `init exit ${ri.status ?? 'null'}\n${ri.stderr}`);
        await fs.symlink('real.txt', path.join(exclVaultDir, 'link.txt'));
        const r = runBfs(['push'], exclVaultDir);
        assert(r.status === 3, `expected exit 3, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const out = r.stdout + r.stderr;
        assert(out.includes('.bfsignore'), `expected .bfsignore hint in: ${out.slice(0, 500)}`);
        assert(out.includes('link.txt'), `expected link.txt listed in: ${out.slice(0, 500)}`);
      }),
    );

    tests.push(
      await runTest('B24', 'push --allow-excluded backs up the rest (exit 0, healthy)', () => {
        const r = runBfs(['push', '--allow-excluded'], exclVaultDir);
        assert(r.status === 0, `expected exit 0, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const out = r.stdout + r.stderr;
        assert(/healthy|zdrow/i.test(out), `expected healthy in: ${out.slice(0, 300)}`);
      }),
    );
  }

  // -- provider remove --strategy rebuild onto a target that cannot be written --
  //
  // Rebuilding is the operator saying "this storage is gone, move its parts".
  // A target that cannot take a single byte must fail as a failure: non-zero
  // exit, the target named, and the configuration exactly as before - the
  // storage still in it, the unusable target withdrawn. A path under an
  // existing file makes the target unusable on every platform.

  tests.push(
    await runTest('B25', 'provider remove --strategy rebuild onto <file>/sub -> exit != 0, target named, config untouched', async () => {
      const blocker = path.join(ctx.sourceDir, 'rebuild-blocker');
      await fs.writeFile(blocker, 'not a directory');
      const before = await readJson<{ providers: Array<{ id: string }> }>(path.join(cliVaultDir, '.bfs', 'config.json'));
      const idsBefore = before.providers.map((p) => p.id);
      assert(idsBefore.includes('cli-p1'), `fixture must still hold cli-p1, got ${idsBefore.join(',')}`);

      const r = runBfs(['provider', 'remove', 'cli-p1', '--strategy', 'rebuild', '--target', 'cli-dead', '--new-type', 'local', '--path', path.join(blocker, 'sub'), '--scope', 'all'], cliVaultDir);

      const out = r.stdout + r.stderr;
      assert(r.status !== 0, `expected exit != 0 for an unusable target, got ${r.status}\n${out}`);
      // The failure itself must name the target as unusable - the note about
      // withdrawing the target names it too, and is not the failure.
      assert(out.includes('Target storage "cli-dead" is not usable'), `expected the target named as not usable in: ${out.slice(0, 600)}`);
      assert(out.includes('same command'), `expected the advice to run the same command again in: ${out.slice(0, 600)}`);
      const after = await readJson<{ providers: Array<{ id: string }> }>(path.join(cliVaultDir, '.bfs', 'config.json'));
      assert(after.providers.map((p) => p.id).join(',') === idsBefore.join(','), `config must be exactly as before, got ${after.providers.map((p) => p.id).join(',')} vs ${idsBefore.join(',')}`);
    }),
  );

  return { name: 'Suite B - CLI init (subprocess)', tests };
}

/**
 * The commands `bfs provider remove --strategy remove` tells the operator to run
 * next. All of them go through the scheme check, so all of them are unreachable
 * while the scheme still counts the storage that was dropped.
 */
const RECOMMENDED_AFTER_REMOVAL: Array<{ label: string; args: string[] }> = [
  { label: 'bfs pull', args: ['pull', '--force'] },
  { label: 'bfs push', args: ['push'] },
  { label: 'bfs prune', args: ['prune', '1', '--yes'] },
];

/**
 * Creates an isolated vault with four local providers (scheme 3+1) and two
 * pushed versions. `provider remove --strategy remove` refuses to drop a storage
 * from a pool of three or fewer, the pushed versions make the removal act on a
 * real backup, and the second version keeps `bfs prune 1` from being refused for
 * deleting the only restorable version - so prune reaches the scheme check.
 *
 * @param sourceDir - Smoke temp root that holds the vault and provider dirs
 * @param name      - Prefix for the vault dir, vault name and provider names
 * @param env       - Environment for every spawned `bfs` (isolated XDG_CONFIG_HOME)
 * @returns           Path of the created vault directory
 */
async function initVaultForRemoval(sourceDir: string, name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const vaultDir = path.join(sourceDir, `${name}-vault`);
  const providerDirs = [1, 2, 3, 4].map((i) => path.join(sourceDir, `${name}-p${i}`));
  await Promise.all([vaultDir, ...providerDirs].map((d) => fs.mkdir(d, { recursive: true })));
  await fs.writeFile(path.join(vaultDir, 'remove-test.txt'), 'provider remove next-steps smoke');

  const initArgs = ['init', `${name}-vault`, '--ci', '--data-shards', '3', '--parity-shards', '1', ...providerDirs.flatMap((d, i) => ['--provider', `local:${name}-p${i + 1} --path ${d}`]), '--push-mode', 'new_version', '--no-enc'];
  const ri = runBfs(initArgs, vaultDir, undefined, env);
  assert(ri.status === 0, `init exit ${ri.status ?? 'null'}\nstdout: ${ri.stdout}\nstderr: ${ri.stderr}`);

  for (const version of [1, 2]) {
    await fs.writeFile(path.join(vaultDir, 'remove-test.txt'), `provider remove next-steps smoke v${version}`);
    const rp = runBfs(['push'], vaultDir, undefined, env);
    assert(rp.status === 0, `push v${version} exit ${rp.status ?? 'null'}\nstdout: ${rp.stdout}\nstderr: ${rp.stderr}`);
  }

  return vaultDir;
}

/**
 * Creates an isolated vault whose stored scheme is unusable: `data_shards` is
 * lowered to 1 in `.bfs/config.json`, below the minimum the format allows - a
 * state only hand-editing produces. No push is needed, because `bfs push`
 * validates the scheme before it touches any data.
 *
 * @param sourceDir - Smoke temp root that holds the vault and provider dirs
 * @param name      - Prefix for the vault dir, vault name and provider names
 * @param env       - Environment for every spawned `bfs` (isolated XDG_CONFIG_HOME)
 * @returns           Path of the created vault directory
 */
async function initVaultWithBrokenScheme(sourceDir: string, name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const vaultDir = path.join(sourceDir, `${name}-vault`);
  const providers = [1, 2, 3].map((i) => ({ id: `${name}-p${i}`, dir: path.join(sourceDir, `${name}-p${i}`) }));
  await Promise.all([vaultDir, ...providers.map((p) => p.dir)].map((d) => fs.mkdir(d, { recursive: true })));
  await fs.writeFile(path.join(vaultDir, 'broken-scheme-test.txt'), 'unusable scheme smoke');

  const ri = runBfs(buildInitArgs(`${name}-vault`, providers, ['--push-mode', 'new_version', '--no-enc']), vaultDir, undefined, env);
  assert(ri.status === 0, `init exit ${ri.status ?? 'null'}\nstdout: ${ri.stdout}\nstderr: ${ri.stderr}`);

  const configPath = path.join(vaultDir, '.bfs', 'config.json');
  const config = await readJson<{ scheme: { data_shards: number; parity_shards: number } }>(configPath);
  config.scheme.data_shards = 1;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  return vaultDir;
}

/**
 * Removes every whitespace run from CLI output so a substring assertion survives
 * the hard wrap Inquirer applies to a piped (non-TTY) stdout at 80 columns - the
 * break lands mid-word, which a plain `includes` would miss.
 *
 * @param text - Raw stdout+stderr of a `bfs` run
 * @returns      The same text with all whitespace stripped
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, '');
}
