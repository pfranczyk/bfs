import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// --- Suite F - Language switching --------------------------------------------

/**
 * Tests persistent UI language switching via `bfs --lang <code>`.
 * Every run gets a config directory of its own, so none of them can reach the
 * settings of the machine the suite runs on: most tests here pin XDG_CONFIG_HOME,
 * while F10/F11 drop it on purpose and redirect every variable the rest of the
 * resolution ladder consults.
 */
export async function suiteF(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const tmpLangDir = path.join(ctx.sourceDir, 'lang-config');
  // XDG_CONFIG_HOME -> highest priority in getGlobalSettingsPath(), works on Windows too
  const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: tmpLangDir };

  tests.push(
    await runTest('F0', 'setup: isolated language config directory', async () => {
      await fs.mkdir(tmpLangDir, { recursive: true });
    }),
  );

  tests.push(
    await runTest('F1', 'bfs --lang pl -> exit 0, Polish output', () => {
      const r = runBfs(['--lang', 'pl', 'status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Język ustawiony na: pl'), `expected Polish confirmation in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F2', 'settings.json contains language: "pl"', async () => {
      const settings = await readJson<{ language: string }>(path.join(tmpLangDir, 'bfs', 'settings.json'));
      assert(settings.language === 'pl', `expected language "pl", got: ${JSON.stringify(settings)}`);
    }),
  );

  tests.push(
    await runTest('F3', 'bfs status (no --lang) -> Polish output', () => {
      const r = runBfs(['status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Status kopii zapasowej'), `expected Polish "Status kopii zapasowej" in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F4', 'bfs --lang en -> exit 0, English output', () => {
      const r = runBfs(['--lang', 'en', 'status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Language set to: en'), `expected English confirmation in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F5', 'bfs status (no --lang) -> English output', () => {
      const r = runBfs(['status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Backup status'), `expected English "Backup status" in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F6', 'bfs --lang en push --help -> --allow-drift (English)', () => {
      const r = runBfs(['--lang', 'en', 'push', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--allow-drift'), `expected --allow-drift flag in: ${out.slice(0, 500)}`);
      assert(out.includes('packing'), `expected English drift description in: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('F7', 'bfs --lang pl push --help -> --allow-drift (Polish)', () => {
      const r = runBfs(['--lang', 'pl', 'push', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--allow-drift'), `expected --allow-drift flag in: ${out.slice(0, 500)}`);
      assert(out.includes('pakowania'), `expected Polish drift description in: ${out.slice(0, 500)}`);
    }),
  );

  // F8/F9 - the FTP provider help (rendered under `bfs provider --help`) lists
  // the FTPS certificate-pinning flags. The flag literals are stable across
  // languages (not translated), so both EN and PL output must contain them.
  tests.push(
    await runTest('F8', 'bfs --lang en provider --help -> FTPS cert flags (English)', () => {
      const r = runBfs(['--lang', 'en', 'provider', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cert-fingerprint'), `expected --cert-fingerprint flag in FTP help: ${out.slice(0, 800)}`);
      assert(out.includes('--accept-new-cert'), `expected --accept-new-cert flag in FTP help: ${out.slice(0, 800)}`);
    }),
  );

  tests.push(
    await runTest('F9', 'bfs --lang pl provider --help -> FTPS cert flags (Polish)', () => {
      const r = runBfs(['--lang', 'pl', 'provider', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cert-fingerprint'), `expected --cert-fingerprint flag in FTP help: ${out.slice(0, 800)}`);
      assert(out.includes('--accept-new-cert'), `expected --accept-new-cert flag in FTP help: ${out.slice(0, 800)}`);
    }),
  );

  // F10/F11 - settings resolved with no XDG_CONFIG_HOME set.
  // getGlobalSettingsPath() tries XDG_CONFIG_HOME, then APPDATA, then the home
  // directory, and every other test in the harness pins the first one - so this
  // is the only place a real `bfs` process walks the rest of that ladder.
  //
  // The two halves use SEPARATE bases on purpose. Sharing one would let the pair
  // pass while resolving to the wrong place entirely: the write would land there
  // and the read would find it, so the round-trip agrees with itself and proves
  // only that both ends went to the same directory, not which one.
  tests.push(
    await runTest('F10', 'bfs --lang pl without XDG_CONFIG_HOME -> settings land on the fallback path', async () => {
      const { env, settingsPath } = fallbackConfigEnv(path.join(ctx.sourceDir, 'lang-fallback-write'));
      const r = runBfs(['--lang', 'pl', 'status'], ctx.vaultDir, undefined, env);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const settings = await readJson<{ language: string }>(settingsPath);
      assert(settings.language === 'pl', `expected language "pl" at ${settingsPath}, got: ${JSON.stringify(settings)}`);
    }),
  );

  tests.push(
    await runTest('F11', 'bfs without XDG_CONFIG_HOME reads the language off the fallback path', async () => {
      const { env, settingsPath } = fallbackConfigEnv(path.join(ctx.sourceDir, 'lang-fallback-read'));

      // Before seeding: nothing is stored anywhere this run can reach, so the
      // built-in 'en' has to win. Without this half the test would also pass on a
      // resolver that escaped to the settings of the machine running the suite -
      // which on a developer box may well hold 'pl' and confirm the claim by
      // accident.
      const before = runBfs(['status'], ctx.vaultDir, undefined, env);
      assert(before.status === 0, `exit ${before.status ?? 'null'}\n${before.stderr}`);
      const beforeOut = before.stdout + before.stderr;
      assert(beforeOut.includes('Backup status'), `with no settings reachable the built-in language must win, got: ${beforeOut.slice(0, 300)}`);

      // Seeded here rather than by a previous `bfs` run, so the read is proved
      // against a file this test put at a known path.
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ language: 'pl' }), 'utf8');

      const r = runBfs(['status'], ctx.vaultDir, undefined, env);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Status kopii zapasowej'), `expected the language stored at ${settingsPath} to drive the output: ${out.slice(0, 300)}`);
    }),
  );

  return { name: 'Suite F - Language switching', tests };
}

/**
 * Builds an environment in which `getGlobalSettingsPath()` cannot reach the
 * settings of the machine running the suite by any of its routes: XDG_CONFIG_HOME
 * is removed and every variable the remaining branches consult points inside
 * `base`. Each branch gets its own subdirectory, so the path the resolver picks
 * says which branch it took.
 *
 * @param base - Directory to confine the whole resolution ladder to
 * @returns      The environment plus the settings path the resolver must pick
 */
function fallbackConfigEnv(base: string): { env: NodeJS.ProcessEnv; settingsPath: string } {
  const appData = path.join(base, 'appdata');
  const home = path.join(base, 'home');
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; set both so the
  // last branch is confined no matter which platform runs this.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.XDG_CONFIG_HOME;

  if (process.platform === 'win32') {
    env.APPDATA = appData;
    return { env, settingsPath: path.join(appData, 'bfs', 'settings.json') };
  }
  // An inherited APPDATA would win over the home directory and the test would
  // then pin a branch this platform never takes in practice.
  delete env.APPDATA;
  return { env, settingsPath: path.join(home, '.config', 'bfs', 'settings.json') };
}
