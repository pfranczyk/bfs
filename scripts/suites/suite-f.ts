import fs from 'node:fs/promises';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// ─── Suite F — Language switching ────────────────────────────────────────────

/**
 * Tests persistent UI language switching via `bfs --lang <code>`.
 * Uses an isolated config directory via XDG_CONFIG_HOME
 * to avoid overwriting the user's real settings.
 */
export async function suiteF(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const tmpLangDir = path.join(ctx.sourceDir, 'lang-config');
  // XDG_CONFIG_HOME → highest priority in getGlobalSettingsPath(), works on Windows too
  const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: tmpLangDir };

  tests.push(
    await runTest('F0', 'setup: isolated language config directory', async () => {
      await fs.mkdir(tmpLangDir, { recursive: true });
    }),
  );

  tests.push(
    await runTest('F1', 'bfs --lang pl → exit 0, Polish output', () => {
      const r = runBfs(['--lang', 'pl', 'status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Język ustawiony na: pl'), `expected Polish confirmation in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F2', 'settings.json contains language: "pl"', async () => {
      const settings = await readJson<{ language: string }>(path.join(tmpLangDir, 'bfs', 'settings.json'));
      assert(settings.language === 'pl', `oczekiwano language "pl", got: ${JSON.stringify(settings)}`);
    }),
  );

  tests.push(
    await runTest('F3', 'bfs status (no --lang) → Polish output', () => {
      const r = runBfs(['status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Status kopii zapasowej'), `expected Polish "Status kopii zapasowej" in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F4', 'bfs --lang en → exit 0, English output', () => {
      const r = runBfs(['--lang', 'en', 'status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Language set to: en'), `expected English confirmation in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F5', 'bfs status (no --lang) → English output', () => {
      const r = runBfs(['status'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Backup status'), `expected English "Backup status" in: ${out.slice(0, 300)}`);
    }),
  );

  tests.push(
    await runTest('F6', 'bfs --lang en push --help → --allow-drift (English)', () => {
      const r = runBfs(['--lang', 'en', 'push', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--allow-drift'), `expected --allow-drift flag in: ${out.slice(0, 500)}`);
      assert(out.includes('packing'), `expected English drift description in: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('F7', 'bfs --lang pl push --help → --allow-drift (Polish)', () => {
      const r = runBfs(['--lang', 'pl', 'push', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--allow-drift'), `expected --allow-drift flag in: ${out.slice(0, 500)}`);
      assert(out.includes('pakowania'), `expected Polish drift description in: ${out.slice(0, 500)}`);
    }),
  );

  // F8/F9 — the FTP provider help (rendered under `bfs provider --help`) lists
  // the FTPS certificate-pinning flags. The flag literals are stable across
  // languages (not translated), so both EN and PL output must contain them.
  tests.push(
    await runTest('F8', 'bfs --lang en provider --help → FTPS cert flags (English)', () => {
      const r = runBfs(['--lang', 'en', 'provider', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cert-fingerprint'), `expected --cert-fingerprint flag in FTP help: ${out.slice(0, 800)}`);
      assert(out.includes('--accept-new-cert'), `expected --accept-new-cert flag in FTP help: ${out.slice(0, 800)}`);
    }),
  );

  tests.push(
    await runTest('F9', 'bfs --lang pl provider --help → FTPS cert flags (Polish)', () => {
      const r = runBfs(['--lang', 'pl', 'provider', '--help'], ctx.vaultDir, undefined, langEnv);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--cert-fingerprint'), `expected --cert-fingerprint flag in FTP help: ${out.slice(0, 800)}`);
      assert(out.includes('--accept-new-cert'), `expected --accept-new-cert flag in FTP help: ${out.slice(0, 800)}`);
    }),
  );

  return { name: 'Suite F — Language switching', tests };
}
