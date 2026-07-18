import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { buildInitArgs, fileExists, readJson } from '../smoke-vault.js';

// ─── Suite B — CLI init (subprocess) ─────────────────────────────────────────

/**
 * Tests `bfs init <name>` as a subprocess with piped stdin.
 * Goal: catch regressions in CLI init argument parsing (e.g. --name → positional arg change).
 * Uses a separate directory from the main ctx — does not interfere with Suite C/D/E.
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
    await runTest('B1', 'bfs init <name> — positional argument + CI flags', () => {
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
    await runTest('B2c', 'init --ci --no-enc → encryption.enabled=false in config', async () => {
      const cfg = await readJson<{ encryption?: { enabled: boolean } }>(path.join(cliVaultDir, '.bfs', 'config.json'));
      assert(cfg.encryption?.enabled === false, `expected encryption.enabled=false with --no-enc, got: ${JSON.stringify(cfg.encryption)}`);
    }),
  );

  // ── Encryption default-ON (no flag) vs opt-out ──────────────────────────────
  tests.push(
    await runTest('B2d', 'init --ci (no flag) → encryption.enabled=true by default', async () => {
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
    await runTest('B2e', 'init --ci --no-enc → unencrypted backup warning (EN)', async () => {
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
      );
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(/NOT encrypted/.test(out), `expected English unencrypted warning in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B2f', 'init --ci --no-enc → unencrypted backup warning (PL)', async () => {
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

  // ── provider add --ci ──────────────────────────────────────────────────────
  const cliP4Dir = path.join(ctx.sourceDir, 'cli-p4');

  tests.push(
    await runTest('B6', 'setup: cli-p4 directory', async () => {
      await fs.mkdir(cliP4Dir, { recursive: true });
    }),
  );

  tests.push(
    await runTest('B7', 'bfs provider add --ci (nowy provider)', async () => {
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
    await runTest('B8', 'bfs provider list — cli-p4 visible', () => {
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

  // ── provider remove --strategy remove --yes ────────────────────────────────

  tests.push(
    await runTest('B9', 'bfs provider remove --strategy remove --yes', () => {
      const r = runBfs(['provider', 'remove', 'cli-p4', '--strategy', 'remove', '--yes'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('B10', 'bfs provider list — cli-p4 removed', () => {
      const r = runBfs(['provider', 'list'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(!out.includes('cli-p4'), `cli-p4 still visible after removal: ${out.slice(0, 300)}`);
    }),
  );

  // ── init --ci --provider pass-through grammar ────────────────────────────
  // type:name + shell-style flags. Credentials live in JSON files, not argv.

  const ptVaultDir = path.join(ctx.sourceDir, 'cli-pt-vault');
  const ptDirs = [path.join(ctx.sourceDir, 'cli-pt-p1'), path.join(ctx.sourceDir, 'cli-pt-p2'), path.join(ctx.sourceDir, 'cli-pt-p3')];

  tests.push(
    await runTest('B11', 'setup: directories + config files for pass-through', async () => {
      await fs.mkdir(ptVaultDir, { recursive: true });
      for (const d of ptDirs) await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(ptVaultDir, 'pt-test.txt'), 'pass-through smoke');
      for (let i = 0; i < ptDirs.length; i++) {
        await fs.writeFile(path.join(ptVaultDir, `p${i + 1}.json`), JSON.stringify({ path: ptDirs[i] }), 'utf8');
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
        ptVaultDir,
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
      const r = runBfs(['--lang', 'en', 'init', 'cli-ftp-bad-vault', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:truenas'], ptVaultDir);
      assert(r.status !== 0, `expected non-zero exit for missing --host, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--provider "ftp:nas --host'), `expected --provider syntax hint in: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B16', 'bfs init --ci ftp:nas (no host) shows --provider syntax in error message (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'init', 'cli-ftp-bad-vault-pl', '--ci', '--data-shards', '2', '--parity-shards', '1', '--provider', 'ftp:truenas'], ptVaultDir);
      assert(r.status !== 0, `expected non-zero exit for missing --host, got ${r.status}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('wewnątrz spec --provider'), `expected Polish --provider syntax message in: ${out.slice(0, 400)}`);
    }),
  );

  // ── provider edit --ci (RED: command not implemented yet) ──────────────────
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
    await runTest('B18', 'bfs provider edit --ci (new path) — exit 0 + id in output', async () => {
      const configFile = path.join(ctx.sourceDir, 'cli-p5-new-config.json');
      await fs.writeFile(configFile, JSON.stringify({ path: cliP5NewDir }), 'utf8');
      const r = runBfs(['provider', 'edit', 'cli-p5', '--ci', '--config-file', configFile], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('cli-p5'), `expected cli-p5 in output: ${out.slice(0, 200)}`);
    }),
  );

  tests.push(
    await runTest('B19', 'bfs provider list — cli-p5 shows the new path', () => {
      const r = runBfs(['provider', 'list'], cliVaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes(cliP5NewDir), `expected new path ${cliP5NewDir} in provider list: ${out.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('B20', 'bfs provider edit nonexistent id — non-zero exit', () => {
      const configFile = path.join(ctx.sourceDir, 'cli-p5-new-config.json');
      const r = runBfs(['provider', 'edit', 'does-not-exist', '--ci', '--config-file', configFile], cliVaultDir);
      assert(r.status !== 0, `expected non-zero exit for nonexistent provider, got ${r.status}`);
    }),
  );

  return { name: 'Suite B — CLI init (subprocess)', tests };
}
