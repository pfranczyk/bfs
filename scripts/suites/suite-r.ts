import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault, readJson } from '../smoke-vault.js';

// ─── Suite R — verify verdicts and what they tell the operator ────────────────
//
// `bfs verify` (shallow) inspects only the shard header window, so it is blind
// to bit-rot in the payload. `bfs verify --deep` must stream the whole shard and
// validate its trailing SHA-256. This suite corrupts one payload byte of a shard
// and asserts:
//   - the `--deep` flag is accepted (listed in verify --help, not "unknown option"),
//   - shallow `verify` still reports healthy (blind by design — stays green),
//   - `verify --deep` reports damage (degraded/damaged),
//   - a verdict carries its provenance and a failed restore names the damaged media,
//   - verify names WHY a part is missing, in both languages, and tells a deleted
//     part from a medium that never answered.

export async function suiteR(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-deep-${Date.now()}`);
  // `--lang` persists the choice in global settings, so every run that passes it
  // gets its own config home — otherwise the suite would leave the machine, and
  // every later suite in the same pass, switched to whichever language it asked
  // for last.
  const langEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: path.join(tmpBase, 'lang-home') };
  const vaultDir = path.join(tmpBase, 'vault');
  const p1Dir = path.join(tmpBase, 'p1');
  const p2Dir = path.join(tmpBase, 'p2');
  const p3Dir = path.join(tmpBase, 'p3');
  const vaultName = 'deep-vault';

  // Reads the health field recorded in the version-1 manifest on disk.
  const manifestHealth = async (): Promise<string> => {
    const m = await readJson<{ health?: string }>(path.join(vaultDir, '.bfs', 'manifests', 'v001.json'));
    return m.health ?? 'unknown';
  };

  // ── R1 — setup: unencrypted, uncompressed vault with a large payload ─────────
  // A 64 KiB incompressible file makes each RS shard payload ~32 KiB, so the
  // shard-header window (magic + location map, ~1 KiB) is a tiny fraction and the
  // mid-file byte flipped in R3 is unambiguously payload, not header.
  tests.push(
    await runTest('R1', 'setup: init --no-enc --no-compress + large payload + push', async () => {
      await initTestVault(
        vaultDir,
        vaultName,
        [
          { id: 'p1', dir: p1Dir },
          { id: 'p2', dir: p2Dir },
          { id: 'p3', dir: p3Dir },
        ],
        ['--no-enc', '--no-compress'],
      );
      await fs.writeFile(path.join(vaultDir, 'bigblob.bin'), crypto.randomBytes(64 * 1024));
      const r = runBfs(['push'], vaultDir);
      assert(r.status === 0, `push exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  // ── R2 — the --deep flag is accepted (not rejected as an unknown option) ─────
  tests.push(
    await runTest('R2', 'bfs verify --help lists --deep (flag accepted)', () => {
      const r = runBfs(['verify', '--help'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--deep'), `expected --deep flag in verify --help: ${out.slice(0, 400)}`);
    }),
  );

  // ── R3 — corrupt one shard's payload; shallow verify stays healthy (blind) ───
  tests.push(
    await runTest('R3', 'corrupt payload byte → bfs verify (shallow) still healthy', async () => {
      const vaultSub = path.join(p1Dir, vaultName);
      const files = await fs.readdir(vaultSub);
      const shard = files.find((f) => /^shard_\d+\.bfs\.1$/.test(f));
      if (shard === undefined) throw new Error(`no shard_*.bfs.1 in ${vaultSub} (files: ${files.join(', ')})`);
      const shardPath = path.join(vaultSub, shard);
      const buf = await fs.readFile(shardPath);
      const mid = Math.floor(buf.length / 2); // payload region (header ~1 KiB, checksum = last 32 B)
      buf[mid] ^= 0xff; // flip one payload byte; do NOT recompute the trailing checksum
      await fs.writeFile(shardPath, buf);

      const r = runBfs(['verify'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const health = await manifestHealth();
      assert(health === 'healthy', `shallow verify should stay blind to payload rot, got health=${health}`);
    }),
  );

  // ── R4 — deep verify detects payload rot the shallow header check is blind to ──
  // The exit code carries the verdict, so a scheduled check can alarm without
  // parsing the table: 0 = healthy, 4 = degraded, 5 = damaged. Both differ from
  // the generic failure code (1), which means verify itself could not run.
  tests.push(
    await runTest('R4', 'bfs verify --deep detects corrupted payload (exit 4 = degraded)', async () => {
      const r = runBfs(['verify', '--deep'], vaultDir);
      const health = await manifestHealth();
      assert(health === 'degraded', `verify --deep should report degraded for one corrupted payload, got health=${health}`);
      assert(r.status === 4, `degraded backup must exit 4, got ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
    }),
  );

  // ── R5 — a second corrupted shard drops the version below N: damaged, exit 5 ──
  tests.push(
    await runTest('R5', 'bfs verify --deep exits 5 when the version is unrecoverable', async () => {
      const vaultSub = path.join(p2Dir, vaultName);
      const files = await fs.readdir(vaultSub);
      const shard = files.find((f) => /^shard_\d+\.bfs\.1$/.test(f));
      if (shard === undefined) throw new Error(`no shard_*.bfs.1 in ${vaultSub} (files: ${files.join(', ')})`);
      const shardPath = path.join(vaultSub, shard);
      const buf = await fs.readFile(shardPath);
      buf[Math.floor(buf.length / 2)] ^= 0xff;
      await fs.writeFile(shardPath, buf);

      const r = runBfs(['verify', '--deep'], vaultDir);
      const health = await manifestHealth();
      assert(health === 'damaged', `two corrupted payloads must read as damaged, got health=${health}`);
      assert(r.status === 5, `damaged backup must exit 5, got ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
    }),
  );

  // ── R6 — a routine shallow verify must not erase the deep verdict ────────────
  // The shallow check reads only the header window, so it cannot see the rot; if
  // it were allowed to overwrite the recorded verdict, the backup would report
  // healthy while being unrecoverable.
  tests.push(
    await runTest('R6', 'shallow bfs verify keeps the recorded damaged verdict (EN)', async () => {
      const r = runBfs(['--lang', 'en', 'verify'], vaultDir, undefined, langEnv);
      const health = await manifestHealth();
      assert(health === 'damaged', `shallow verify must not upgrade a deep damaged verdict, got health=${health}`);
      assert(r.status === 5, `damaged backup must exit 5, got ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('earlier deep check'), `operator must be told where the verdict comes from: ${out.slice(0, 400)}`);
    }),
  );

  // ── R7 — the same explanation exists in Polish (both keys must be present) ───
  tests.push(
    await runTest('R7', 'retained-verdict message is translated (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'verify'], vaultDir, undefined, langEnv);
      assert(r.status === 5, `damaged backup must exit 5, got ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('sprawdzenia głębokiego'), `expected the Polish retained-verdict message: ${out.slice(0, 400)}`);
    }),
  );

  // ── R8/R9 — a restore that cannot go ahead names the damaged media ──────────
  // Two of three parts are rotted at this point, so the version is below N. The
  // operator's next move depends on the cause, so the failure must say which
  // media hold damaged data instead of guessing that something is offline.
  //
  // Three sentences carry that, and each is pinned verbatim in both languages.
  // A part that read back but failed its own checksum is named as it is dropped,
  // under the medium's name — a part index is internal and must never surface in
  // the UI. The verdict that follows states that this version is beyond restoring
  // from the media available now, and sends the operator to `bfs verify` for the
  // versions that are not. The attribution sentence then ends at the media it
  // names: it carries no rebuild advice, because reaching this message means
  // fewer healthy parts survive than a rebuild needs, so `bfs repair --rebuild`
  // would be a dead end.
  tests.push(
    await runTest('R8', 'failed pull names the damaged media (EN)', () => {
      const r = runBfs(['--lang', 'en', 'pull', '--force', '--yes'], vaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with two damaged parts, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/damaged/i.test(out), `expected the cause to be named as damage: ${out.slice(0, 500)}`);
      assert(/\bp1\b/.test(out) && /\bp2\b/.test(out), `expected the damaged media to be named: ${out.slice(0, 500)}`);
      // Every medium answered, so blaming an unreachable or emptied one would send
      // the operator after the wrong problem. Guarding the sentences those causes
      // actually print — the word "offline" appears in none of them.
      assert(!out.includes('Storage not reachable:'), `must not blame an unreachable medium when the data is damaged: ${out.slice(0, 500)}`);
      assert(!out.includes('Backup data missing on:'), `must not report damaged data as missing: ${out.slice(0, 500)}`);
      assert(out.includes('Backup data on "p1" is damaged — skipping it.') && out.includes('Backup data on "p2" is damaged — skipping it.'), `each damaged part must be named as it is dropped: ${out.slice(0, 500)}`);
      assert(!/\bpiece \d/i.test(out), `the damage must be attributed to the medium, not an internal part number: ${out.slice(0, 500)}`);
      assert(out.includes('this version cannot be restored from the storage available now.'), `the verdict must say the version is beyond restoring from what is available: ${out.slice(0, 500)}`);
      assert(
        out.includes('Run `bfs verify --deep` to see which versions still can.'),
        `the verdict must point at \`bfs verify --deep\` — the shallow check is blind to payload rot (see R3), so it would call this very version healthy: ${out.slice(0, 500)}`,
      );
      assert(out.includes('Damaged backup data on: p1, p2.'), `the attribution sentence must end at the media it names: ${out.slice(0, 500)}`);
      assert(!out.includes('bfs repair --rebuild'), `a rebuild needs more healthy parts than survived here, so it must not be advised: ${out.slice(0, 500)}`);
    }),
  );

  tests.push(
    await runTest('R9', 'failed pull names the damaged media (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'pull', '--force', '--yes'], vaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with two damaged parts, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(/uszkodzone dane/i.test(out), `expected the Polish damage message: ${out.slice(0, 500)}`);
      assert(out.includes('Dane kopii na nośniku "p1" są uszkodzone — pomijam.') && out.includes('Dane kopii na nośniku "p2" są uszkodzone — pomijam.'), `each damaged part must be named as it is dropped: ${out.slice(0, 500)}`);
      assert(!/\bcz[ęe]ść \d/i.test(out), `the damage must be attributed to the medium, not an internal part number: ${out.slice(0, 500)}`);
      assert(out.includes('tej wersji nie da się odtworzyć z nośników dostępnych w tej chwili.'), `the verdict must say the version is beyond restoring from what is available: ${out.slice(0, 500)}`);
      assert(out.includes('Uruchom `bfs verify --deep`, aby zobaczyć, które wersje wciąż można odtworzyć.'), `the verdict must point at \`bfs verify --deep\` — the shallow check is blind to payload rot (see R3): ${out.slice(0, 500)}`);
      assert(out.includes('Uszkodzone dane kopii na nośnikach: p1, p2.'), `the attribution sentence must end at the media it names: ${out.slice(0, 500)}`);
      assert(!out.includes('bfs repair --rebuild'), `a rebuild needs more healthy parts than survived here, so it must not be advised: ${out.slice(0, 500)}`);
    }),
  );

  // ── R10/R11 — verify names why a part is missing, in both languages ─────────
  // A count alone cannot be acted on: "2/3" reads the same for a medium that is
  // switched off and for a part that was deleted, yet one calls for bringing the
  // medium back and the other for rebuilding the part. The two causes therefore
  // have to reach the operator as different sentences, and a medium that never
  // answered must not be reported as a missing file.
  const causeVaultDir = path.join(tmpBase, 'cause-vault');
  const c1Dir = path.join(tmpBase, 'c1');
  const c2Dir = path.join(tmpBase, 'c2');
  const c3Dir = path.join(tmpBase, 'c3');
  const causeVaultName = 'cause-vault';

  tests.push(
    await runTest('R10', 'verify tells a deleted part from an unreachable medium (EN)', async () => {
      await initTestVault(
        causeVaultDir,
        causeVaultName,
        [
          { id: 'c1', dir: c1Dir },
          { id: 'c2', dir: c2Dir },
          { id: 'c3', dir: c3Dir },
        ],
        ['--no-enc'],
      );
      const pushed = runBfs(['push'], causeVaultDir);
      assert(pushed.status === 0, `push exit ${pushed.status ?? 'null'}\n${pushed.stdout}\n${pushed.stderr}`);

      // c2 answers but its part is gone; c3 is away entirely (drive unplugged).
      const c2Vault = path.join(c2Dir, causeVaultName);
      const c2Files = await fs.readdir(c2Vault);
      const c2Shard = c2Files.find((f) => /^shard_\d+\.bfs\.1$/.test(f));
      if (c2Shard === undefined) throw new Error(`no shard_*.bfs.1 in ${c2Vault} (files: ${c2Files.join(', ')})`);
      await fs.rm(path.join(c2Vault, c2Shard));
      await fs.rm(c3Dir, { recursive: true, force: true });

      const r = runBfs(['--lang', 'en', 'verify'], causeVaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('could not be read on provider "c2" — missing or unreadable'), `a deleted part must be named under its medium: ${out.slice(0, 600)}`);
      assert(out.includes('could not be checked — provider "c3" is unreachable'), `an unreachable medium must be named as unreachable: ${out.slice(0, 600)}`);
      assert(!out.includes('provider "c3" — missing or unreadable'), `a medium that never answered must not be reported as a missing file: ${out.slice(0, 600)}`);
      assert(!out.includes('"c2" failed integrity check'), `nothing was read from c2, so its data must not be called corrupt: ${out.slice(0, 600)}`);
    }),
  );

  tests.push(
    await runTest('R11', 'verify tells a deleted part from an unreachable medium (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'verify'], causeVaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('na nośniku "c2" — brak pliku lub błąd odczytu'), `a deleted part must be named under its medium: ${out.slice(0, 600)}`);
      assert(out.includes('nośnik "c3" jest nieosiągalny'), `an unreachable medium must be named as unreachable: ${out.slice(0, 600)}`);
      assert(!out.includes('nośniku "c3" — brak pliku'), `a medium that never answered must not be reported as a missing file: ${out.slice(0, 600)}`);
    }),
  );

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  return { name: 'Suite R — verify verdicts (payload integrity, named causes)', tests };
}
