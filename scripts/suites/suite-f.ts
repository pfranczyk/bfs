import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists, readJson } from '../smoke-vault.js';

// --- Suite F - Language and working-directory flags -------------------------

/**
 * Tests the two global flags that carry a value: `--lang <code>`, which settles
 * the interface language for good, and `--cwd <dir>`, which settles where the
 * run works. Both are read before any command is built, so neither is Commander's
 * to check, and both are refused here when the value is missing.
 *
 * Every test that touches stored settings gets a config directory of its own, so
 * none can reach the settings of the machine the suite runs on: most pin
 * XDG_CONFIG_HOME, while F10/F11 drop it on purpose and redirect every variable
 * the rest of the resolution ladder consults. The `--cwd` cases store nothing,
 * so they inherit the environment and assert on the refusal alone.
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

  // F12-F15 - the language flag carries a closed set, so anything outside it is
  // a mistake to report, not a value to store. Getting this wrong is quiet and
  // lasting: the setting is written, the confirmation claims success, the run
  // exits 0 - and every later command speaks the built-in language instead,
  // with nothing on screen tying that back to the flag that did it.
  //
  // Fed a fresh directory each time, so what a case proves cannot depend on
  // what an earlier one stored.
  tests.push(
    await runTest('F12', 'bfs --lang <unknown> -> refused, nothing stored', async () => {
      const dir = path.join(ctx.sourceDir, 'lang-reject-unknown');
      await fs.mkdir(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      const r = runBfs(['--lang', 'klingon', 'status'], ctx.vaultDir, undefined, env);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `an unusable language must not exit 0, got ${r.status}\n${out.slice(0, 300)}`);
      assert(/^X .*klingon/m.test(out), `the refusal must name the value it turned away: ${out.slice(0, 300)}`);
      // Naming what IS available is what makes the refusal actionable - without
      // it the operator learns only that they guessed wrong.
      assert(/\ben\b/.test(out) && /\bpl\b/.test(out), `the refusal must name the languages that do work: ${out.slice(0, 300)}`);
      assert(!out.includes('Language set to'), `a refused language must not be confirmed as set: ${out.slice(0, 300)}`);
      const stored = await fileExists(path.join(dir, 'bfs', 'settings.json'));
      assert(!stored, 'a refused language must not be written to the settings');
    }),
  );

  tests.push(
    await runTest('F13', 'bfs --lang with a flag where the value belongs -> refused, nothing stored', async () => {
      const dir = path.join(ctx.sourceDir, 'lang-reject-flag');
      await fs.mkdir(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      // The shape a real slip takes: the value is simply missing, so the flag
      // that followed is swallowed as one.
      const r = runBfs(['--lang', '--version'], ctx.vaultDir, undefined, env);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `a missing language value must not exit 0, got ${r.status}\n${out.slice(0, 300)}`);
      assert(!out.includes('Language set to'), `a swallowed flag must not be confirmed as a language: ${out.slice(0, 300)}`);
      // Named, and named as this tool's refusal. Exiting non-zero is not enough:
      // an unrecognised-option complaint from the argument parser would satisfy
      // that too, and it would tell the operator nothing about which flag went
      // short of its value.
      assert(/^X .*--lang/m.test(out), `the refusal must name the flag that is short of its value: ${out.slice(0, 300)}`);
      const stored = await fileExists(path.join(dir, 'bfs', 'settings.json'));
      assert(!stored, 'a swallowed flag must not be written to the settings');
    }),
  );

  tests.push(
    await runTest('F13b', 'bfs --lang with nothing after it at all -> refused, same as the directory flag', async () => {
      // The other way the value goes missing, and the one a script produces on
      // its own when a variable never got set. The directory flag answers this
      // shape too (F16); a run that says nothing about either is a run the
      // operator has no way to question.
      const dir = path.join(ctx.sourceDir, 'lang-reject-empty');
      await fs.mkdir(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      const trailing = runBfs(['--lang'], ctx.vaultDir, '', env);
      const trailingOut = `${trailing.stdout ?? ''}${trailing.stderr ?? ''}`;
      assert(trailing.status !== 0, `a language flag with no value must not exit 0, got ${trailing.status}\n${trailingOut.slice(0, 300)}`);
      assert(/^X .*--lang/m.test(trailingOut), `the refusal must name the flag: ${trailingOut.slice(0, 300)}`);

      const empty = runBfs(['--lang', '', 'status'], ctx.vaultDir, '', env);
      const emptyOut = `${empty.stdout ?? ''}${empty.stderr ?? ''}`;
      assert(empty.status !== 0, `an empty language value must not exit 0, got ${empty.status}\n${emptyOut.slice(0, 300)}`);

      const stored = await fileExists(path.join(dir, 'bfs', 'settings.json'));
      assert(!stored, 'neither shape may be written to the settings');
    }),
  );

  tests.push(
    await runTest('F14', 'a stored language that no longer works is said out loud, not silently ignored', async () => {
      // A settings file can hold a language the interface does not have - edited
      // by hand, or written by a build that took the value on trust. The tool
      // then speaks one nobody chose, and without a word about it there is
      // nothing to connect that to the setting. It cannot refuse the work over a
      // preference, so it says what happened and how to change it.
      const dir = path.join(ctx.sourceDir, 'lang-stored-unusable');
      const settingsPath = path.join(dir, 'bfs', 'settings.json');
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify({ language: '--version' }), 'utf8');
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      const r = runBfs(['status'], ctx.vaultDir, undefined, env);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(/^! .*--lang/m.test(out), `an unusable stored language must be pointed out, naming the way out: ${out.slice(0, 300)}`);
      // A preference that cannot be honoured is not a reason to refuse the work.
      assert(r.status === 0, `a stored preference must not fail the command, got ${r.status}\n${out.slice(0, 300)}`);

      // The advice is followed here rather than matched: a notice pointing at a
      // command that does not actually clear the state would read as help while
      // leaving the operator exactly where they were.
      const fix = runBfs(['--lang', 'en', 'status'], ctx.vaultDir, undefined, env);
      assert(fix.status === 0, `the advised command must work, got ${fix.status}\n${fix.stderr}`);
      const settings = await readJson<{ language: string }>(settingsPath);
      assert(settings.language === 'en', `the advised command must replace the unusable value, got: ${JSON.stringify(settings)}`);

      const after = runBfs(['status'], ctx.vaultDir, undefined, env);
      const afterOut = `${after.stdout ?? ''}${after.stderr ?? ''}`;
      assert(!/^! .*--lang/m.test(afterOut), `once fixed, the notice must stop: ${afterOut.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F14b', 'the refusal speaks the language already in use, not the one being asked for', async () => {
      // Which language a refusal comes back in is not a detail here: the whole
      // point of the flag is that the operator picked one, and being turned away
      // in a language they did not pick is the tool forgetting that mid-sentence.
      // It cannot be the language being requested either - that one is exactly
      // what is unusable. So it is the one already in force.
      const dir = path.join(ctx.sourceDir, 'lang-reject-in-polish');
      await fs.mkdir(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      const setup = runBfs(['--lang', 'pl', 'status'], ctx.vaultDir, undefined, env);
      assert(setup.status === 0, `setup: expected Polish to be accepted, got ${setup.status}\n${setup.stderr}`);

      const r = runBfs(['--lang', 'klingon', 'status'], ctx.vaultDir, undefined, env);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `an unusable language must not exit 0, got ${r.status}\n${out.slice(0, 300)}`);
      // Anchored on the wording every other refusal of a closed set uses, so the
      // check moves with the project rather than pinning one sentence.
      assert(/Nieprawid|Dozwolone/.test(out), `expected the refusal in the language already in use: ${out.slice(0, 300)}`);
      assert(!/\bAllowed\b|\bInvalid\b/.test(out), `the refusal must not fall back to English: ${out.slice(0, 300)}`);
      // And the language that was in force must survive the refusal.
      const settings = await readJson<{ language: string }>(path.join(dir, 'bfs', 'settings.json'));
      assert(settings.language === 'pl', `a refused change must leave the working language alone, got: ${JSON.stringify(settings)}`);
    }),
  );

  tests.push(
    await runTest('F15', 'a language that does work is still accepted, quietly (A/B control)', async () => {
      // The other side of the gate. A check that turned away everything would
      // pass every assertion above and break the feature entirely.
      const dir = path.join(ctx.sourceDir, 'lang-accept-known');
      await fs.mkdir(dir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: dir };

      const r = runBfs(['--lang', 'pl', 'status'], ctx.vaultDir, undefined, env);
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status === 0, `a supported language must be accepted, got ${r.status}\n${out.slice(0, 300)}`);
      assert(out.includes('Język ustawiony na: pl'), `expected the Polish confirmation: ${out.slice(0, 300)}`);
      const settings = await readJson<{ language: string }>(path.join(dir, 'bfs', 'settings.json'));
      assert(settings.language === 'pl', `expected language "pl", got: ${JSON.stringify(settings)}`);
    }),
  );

  // F16 - the working-directory flag takes a value too, and the same slip has a
  // quieter ending there: with the value missing the run opens the prompt in
  // whatever directory it happened to start in, which is not the one the
  // operator was pointing at.
  tests.push(
    await runTest('F16', 'bfs --cwd with no directory -> refused instead of falling back silently', () => {
      const r = runBfs(['--cwd'], ctx.vaultDir, '');
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `a missing working directory must not exit 0, got ${r.status}\n${out.slice(0, 300)}`);
      assert(/^X .*--cwd/m.test(out), `the refusal must name the flag that is short of its value: ${out.slice(0, 300)}`);

      // What an unset variable expands to in a script - `bfs --cwd "$DIR"` with
      // DIR never assigned. The flag is there, the value is not, and carrying on
      // in the directory the run started from is the outcome this refuses. Both
      // spellings produce it, so both are held to the same answer; writing it
      // one way must not be a way around the check.
      for (const shape of [
        ['--cwd', '', 'status'],
        ['--cwd=', 'status'],
      ]) {
        const blank = runBfs(shape, ctx.vaultDir, '');
        const blankOut = `${blank.stdout ?? ''}${blank.stderr ?? ''}`;
        assert(blank.status !== 0, `an empty working directory must not exit 0 (${shape.join(' ')}), got ${blank.status}\n${blankOut.slice(0, 300)}`);
        assert(/^X .*--cwd/m.test(blankOut), `the refusal must name the flag (${shape.join(' ')}): ${blankOut.slice(0, 300)}`);
      }
    }),
  );

  tests.push(
    await runTest('F17', 'bfs --cwd followed by a flag -> refused, and the version is not what answers', () => {
      // The value is missing here too, and the flag behind it gets eaten. The
      // run then answers as though the operator had asked for the version.
      const r = runBfs(['--cwd', '--version'], ctx.vaultDir, '');
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      assert(r.status !== 0, `a swallowed flag must not exit 0, got ${r.status}\n${out.slice(0, 300)}`);
      assert(!/^\d+\.\d+\.\d+\s*$/m.test(out), `a version number must not stand in for the refusal: ${out.slice(0, 300)}`);
      assert(/^X .*--cwd/m.test(out), `the refusal must name the flag that is short of its value: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F18', 'bfs --cwd <dir> still works (A/B control)', () => {
      // Guards the gate against turning away real directories - in both
      // spellings, since the check now reads both.
      for (const shape of [
        ['--cwd', ctx.vaultDir, 'status'],
        [`--cwd=${ctx.vaultDir}`, 'status'],
      ]) {
        const r = runBfs(shape, ctx.sourceDir);
        const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
        assert(r.status === 0, `a directory given properly must be accepted (${shape.join(' ')}), got ${r.status}\n${out.slice(0, 300)}`);
      }
    }),
  );
  return { name: 'Suite F - Language and working-directory flags', tests };
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
