import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { initTestVault, readJson, verifyShaHashes } from '../smoke-vault.js';

// --- Suite R - verify verdicts and what they tell the operator ----------------
//
// `bfs verify` (shallow) inspects only the shard header window, so it is blind
// to bit-rot in the payload. `bfs verify --deep` must stream the whole shard and
// validate its trailing SHA-256. This suite corrupts one payload byte of a shard
// and asserts:
//   - the `--deep` flag is accepted (listed in verify --help, not "unknown option"),
//   - shallow `verify` still reports healthy (blind by design - stays green),
//   - `verify --deep` reports damage (degraded/damaged),
//   - a verdict carries its provenance and a failed restore names the damaged media,
//   - verify names WHY a part is missing, in both languages, and tells a deleted
//     part from a medium that never answered.
//
// From R12 on, the same question is asked of the FAILED RESTORE rather than of
// verify: every cause it can report has to reach the operator as its own
// sentence, naming its own media, in both languages. R12/R13 an unreachable
// medium, R14 a deleted part (Polish - English is pinned by the e2e scenario),
// R15/R16 a medium dropped from the configuration and one whose adapter is not
// installed, R17/R18 parts belonging to another version. R19 asks it of a
// restore that SUCCEEDS: an encrypted version where one refused part is covered
// by the parity, and the password must not be blamed for it. Each builds its own
// vault, so the cumulative damage R3/R5 inflict above stays out of the way.

export async function suiteR(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-deep-${Date.now()}`);
  // `--lang` persists the choice in global settings, so every run that passes it
  // gets its own config home - otherwise the suite would leave the machine, and
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

  // -- R1 - setup: unencrypted, uncompressed vault with a large payload ---------
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

  // -- R2 - the --deep flag is accepted (not rejected as an unknown option) -----
  tests.push(
    await runTest('R2', 'bfs verify --help lists --deep (flag accepted)', () => {
      const r = runBfs(['verify', '--help'], vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('--deep'), `expected --deep flag in verify --help: ${out.slice(0, 400)}`);
    }),
  );

  // -- R3 - corrupt one shard's payload; shallow verify stays healthy (blind) ---
  tests.push(
    await runTest('R3', 'corrupt payload byte -> bfs verify (shallow) still healthy', async () => {
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

  // -- R4 - deep verify detects payload rot the shallow header check is blind to --
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

  // -- R5 - a second corrupted shard drops the version below N: damaged, exit 5 --
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

  // -- R6 - a routine shallow verify must not erase the deep verdict ------------
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

  // -- R7 - the same explanation exists in Polish (both keys must be present) ---
  tests.push(
    await runTest('R7', 'retained-verdict message is translated (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'verify'], vaultDir, undefined, langEnv);
      assert(r.status === 5, `damaged backup must exit 5, got ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('sprawdzenia głębokiego'), `expected the Polish retained-verdict message: ${out.slice(0, 400)}`);
    }),
  );

  // -- R8/R9 - a restore that cannot go ahead names the damaged media ----------
  // Two of three parts are rotted at this point, so the version is below N. The
  // operator's next move depends on the cause, so the failure must say which
  // media hold damaged data instead of guessing that something is offline.
  //
  // Three sentences carry that, and each is pinned verbatim in both languages.
  // A part that read back but failed its own checksum is named as it is dropped,
  // under the medium's name - a part index is internal and must never surface in
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
      // actually print - the word "offline" appears in none of them.
      assert(!out.includes('Storage not reachable:'), `must not blame an unreachable medium when the data is damaged: ${out.slice(0, 500)}`);
      assert(!out.includes('Backup data missing on:'), `must not report damaged data as missing: ${out.slice(0, 500)}`);
      assert(out.includes('Backup data on "p1" is damaged - skipping it.') && out.includes('Backup data on "p2" is damaged - skipping it.'), `each damaged part must be named as it is dropped: ${out.slice(0, 500)}`);
      assert(!/\bpiece \d/i.test(out), `the damage must be attributed to the medium, not an internal part number: ${out.slice(0, 500)}`);
      assert(out.includes('this version cannot be restored from the storage available now.'), `the verdict must say the version is beyond restoring from what is available: ${out.slice(0, 500)}`);
      assert(
        out.includes('Run `bfs verify --deep` to see which versions still can.'),
        `the verdict must point at \`bfs verify --deep\` - the shallow check is blind to payload rot (see R3), so it would call this very version healthy: ${out.slice(0, 500)}`,
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
      assert(out.includes('Dane kopii na nośniku "p1" są uszkodzone - pomijam.') && out.includes('Dane kopii na nośniku "p2" są uszkodzone - pomijam.'), `each damaged part must be named as it is dropped: ${out.slice(0, 500)}`);
      assert(!/\bcz[ęe]ść \d/i.test(out), `the damage must be attributed to the medium, not an internal part number: ${out.slice(0, 500)}`);
      assert(out.includes('tej wersji nie da się odtworzyć z nośników dostępnych w tej chwili.'), `the verdict must say the version is beyond restoring from what is available: ${out.slice(0, 500)}`);
      assert(out.includes('Uruchom `bfs verify --deep`, aby zobaczyć, które wersje wciąż można odtworzyć.'), `the verdict must point at \`bfs verify --deep\` - the shallow check is blind to payload rot (see R3): ${out.slice(0, 500)}`);
      assert(out.includes('Uszkodzone dane kopii na nośnikach: p1, p2.'), `the attribution sentence must end at the media it names: ${out.slice(0, 500)}`);
      assert(!out.includes('bfs repair --rebuild'), `a rebuild needs more healthy parts than survived here, so it must not be advised: ${out.slice(0, 500)}`);
    }),
  );

  // -- R10/R11 - verify names why a part is missing, in both languages ---------
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
      assert(out.includes('could not be read on provider "c2" - missing or unreadable'), `a deleted part must be named under its medium: ${out.slice(0, 600)}`);
      assert(out.includes('could not be checked - provider "c3" is unreachable'), `an unreachable medium must be named as unreachable: ${out.slice(0, 600)}`);
      assert(!out.includes('provider "c3" - missing or unreadable'), `a medium that never answered must not be reported as a missing file: ${out.slice(0, 600)}`);
      assert(!out.includes('"c2" failed integrity check'), `nothing was read from c2, so its data must not be called corrupt: ${out.slice(0, 600)}`);
    }),
  );

  tests.push(
    await runTest('R11', 'verify tells a deleted part from an unreachable medium (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'verify'], causeVaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(out.includes('na nośniku "c2" - brak pliku lub błąd odczytu'), `a deleted part must be named under its medium: ${out.slice(0, 600)}`);
      assert(out.includes('nośnik "c3" jest nieosiągalny'), `an unreachable medium must be named as unreachable: ${out.slice(0, 600)}`);
      assert(!out.includes('nośniku "c3" - brak pliku'), `a medium that never answered must not be reported as a missing file: ${out.slice(0, 600)}`);
    }),
  );

  // -- R12/R13 - a failed restore names the media that never answered ----------
  // The mirror of R8/R9 for the opposite cause. There the media answered and
  // their data was rotted; here they are gone, and nothing was read from them at
  // all - so calling that data damaged or deleted would send the operator to
  // repair or rebuild bytes that are most likely intact behind an unplugged
  // drive. `verify` already tells these apart (R10/R11); until now a failed pull
  // was only ever asserted NOT to blame an unreachable medium, never to name one
  // when that is genuinely what happened.
  const offVaultDir = path.join(tmpBase, 'off-vault');
  const o1Dir = path.join(tmpBase, 'o1');
  const o2Dir = path.join(tmpBase, 'o2');
  const o3Dir = path.join(tmpBase, 'o3');
  const offVaultName = 'off-vault';

  tests.push(
    await runTest('R12', 'failed pull names the unreachable media (EN)', async () => {
      await initTestVault(
        offVaultDir,
        offVaultName,
        [
          { id: 'o1', dir: o1Dir },
          { id: 'o2', dir: o2Dir },
          { id: 'o3', dir: o3Dir },
        ],
        ['--no-enc'],
      );
      const pushed = runBfs(['push'], offVaultDir);
      assert(pushed.status === 0, `push exit ${pushed.status ?? 'null'}\n${pushed.stdout}\n${pushed.stderr}`);

      // Two of three drives are unplugged - below N, so the restore cannot go on.
      await fs.rm(o2Dir, { recursive: true, force: true });
      await fs.rm(o3Dir, { recursive: true, force: true });

      const r = runBfs(['--lang', 'en', 'pull', '--force', '--yes'], offVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with two media away, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Storage not reachable: o2, o3.'), `the unreachable media must be named: ${out.slice(0, 600)}`);
      // Nothing was read from either medium, so neither verdict about its bytes
      // can have been formed - and both would cost the operator a wasted move.
      assert(!out.includes('Damaged backup data on:'), `nothing was read, so no data may be called damaged: ${out.slice(0, 600)}`);
      assert(!out.includes('Backup data missing on:'), `an unreachable medium must not be reported as a deleted part: ${out.slice(0, 600)}`);
    }),
  );

  tests.push(
    await runTest('R13', 'failed pull names the unreachable media (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'pull', '--force', '--yes'], offVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with two media away, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Nośniki nieosiągalne: o2, o3.'), `the unreachable media must be named: ${out.slice(0, 600)}`);
      assert(!out.includes('Uszkodzone dane kopii na nośnikach:'), `nothing was read, so no data may be called damaged: ${out.slice(0, 600)}`);
      assert(!out.includes('Brak danych kopii na nośnikach:'), `an unreachable medium must not be reported as a deleted part: ${out.slice(0, 600)}`);
    }),
  );

  // -- R14 - a deleted part reads as absent in Polish too ----------------------
  // The English half of this sentence is pinned by the e2e scenario; its Polish
  // pair was the one attribution sentence with no assertion anywhere, so a
  // mistranslation would have shipped unnoticed.
  const goneVaultDir = path.join(tmpBase, 'gone-vault');
  const g1Dir = path.join(tmpBase, 'g1');
  const g2Dir = path.join(tmpBase, 'g2');
  const g3Dir = path.join(tmpBase, 'g3');
  const goneVaultName = 'gone-vault';

  tests.push(
    await runTest('R14', 'failed pull names the media whose part was deleted (PL)', async () => {
      await initTestVault(
        goneVaultDir,
        goneVaultName,
        [
          { id: 'g1', dir: g1Dir },
          { id: 'g2', dir: g2Dir },
          { id: 'g3', dir: g3Dir },
        ],
        ['--no-enc'],
      );
      const pushed = runBfs(['push'], goneVaultDir);
      assert(pushed.status === 0, `push exit ${pushed.status ?? 'null'}\n${pushed.stdout}\n${pushed.stderr}`);

      // Both media answer; their parts are simply gone.
      for (const [dir, id] of [
        [g2Dir, 'g2'],
        [g3Dir, 'g3'],
      ] as const) {
        const sub = path.join(dir, goneVaultName);
        const files = await fs.readdir(sub);
        const shard = files.find((f) => /^shard_\d+\.bfs\.1$/.test(f));
        if (shard === undefined) throw new Error(`no shard_*.bfs.1 for ${id} in ${sub} (files: ${files.join(', ')})`);
        await fs.rm(path.join(sub, shard));
      }

      const r = runBfs(['--lang', 'pl', 'pull', '--force', '--yes'], goneVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with two parts deleted, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Brak danych kopii na nośnikach: g2, g3.'), `the media whose parts are gone must be named: ${out.slice(0, 600)}`);
      assert(!out.includes('Nośniki nieosiągalne:'), `the media answered, so they must not be called unreachable: ${out.slice(0, 600)}`);
      assert(!out.includes('Uszkodzone dane kopii na nośnikach:'), `a deleted part is not damaged data: ${out.slice(0, 600)}`);
    }),
  );

  // -- R15/R16 - the two causes that are fixed off the media, in both languages -
  // A medium dropped from the configuration and one whose adapter is not
  // installed are the two causes an operator resolves without touching any
  // storage - by restoring a name, or by installing a package. Both were pinned
  // only for the degraded, successful restore; on the failing path neither
  // sentence had an assertion in any language, so a mistranslation or a dropped
  // entry in the naming table would have gone out unnoticed. Provoking both in
  // one run pins each medium to its own cause: swapping the two keys in the
  // naming table would move n2 and n3 into each other's sentence and fail both
  // assertions, which two separate runs would not catch. The ORDER of the
  // sentences is not asserted - these are independent substring checks.
  const offMapVaultDir = path.join(tmpBase, 'offmap-vault');
  const n1Dir = path.join(tmpBase, 'n1');
  const n2Dir = path.join(tmpBase, 'n2');
  const n3Dir = path.join(tmpBase, 'n3');
  const offMapVaultName = 'offmap-vault';

  tests.push(
    await runTest('R15', 'failed pull names a dropped medium and one lacking its adapter (EN)', async () => {
      await initTestVault(
        offMapVaultDir,
        offMapVaultName,
        [
          { id: 'n1', dir: n1Dir },
          { id: 'n2', dir: n2Dir },
          { id: 'n3', dir: n3Dir },
        ],
        ['--no-enc'],
      );
      const pushed = runBfs(['push'], offMapVaultDir);
      assert(pushed.status === 0, `push exit ${pushed.status ?? 'null'}\n${pushed.stdout}\n${pushed.stderr}`);

      // After the push, so the manifest keeps the names the parts were written
      // under: n2 is renamed out of the configuration, n3 keeps its name but
      // moves to a type no adapter is registered for. Both parts stay on disk.
      const cfgPath = path.join(offMapVaultDir, '.bfs', 'config.json');
      const cfg = await readJson<{ providers: Array<{ id: string; type: string; adapterPackage: Nullable<string> }> }>(cfgPath);
      const dropped = cfg.providers.find((p) => p.id === 'n2');
      const ghost = cfg.providers.find((p) => p.id === 'n3');
      if (dropped === undefined || ghost === undefined) throw new Error(`fixture must have n2 and n3 (got: ${cfg.providers.map((p) => p.id).join(', ')})`);
      dropped.id = 'n2-renamed';
      ghost.type = 'ghost-cloud';
      ghost.adapterPackage = 'bfs-adapter-ghost@1.0.0';
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

      // Without the flag the preflight refuses before any part is fetched, so the
      // attribution is only reachable once the run has opted into carrying on.
      const r = runBfs(['--lang', 'en', 'pull', '--force', '--yes', '--allow-missing-adapters'], offMapVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with only one usable medium, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Storage recorded in this backup but absent from the configuration: n2.'), `the dropped medium must be named under the name the backup records: ${out.slice(0, 700)}`);
      assert(out.includes('Storage needing an adapter that is not installed: n3.'), `the medium lacking its adapter must be named: ${out.slice(0, 700)}`);
      // Both media are intact and answering - blaming their bytes would send the
      // operator to repair data that is not the problem.
      assert(!out.includes('Damaged backup data on:'), `nothing is damaged here: ${out.slice(0, 700)}`);
      assert(!out.includes('Backup data missing on:'), `both parts are still on their media: ${out.slice(0, 700)}`);
    }),
  );

  tests.push(
    await runTest('R16', 'failed pull names a dropped medium and one lacking its adapter (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'pull', '--force', '--yes', '--allow-missing-adapters'], offMapVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with only one usable medium, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Nośniki zapisane w tej kopii, ale nieobecne w konfiguracji: n2.'), `the dropped medium must be named: ${out.slice(0, 700)}`);
      assert(out.includes('Nośniki wymagające niezainstalowanego adaptera: n3.'), `the medium lacking its adapter must be named: ${out.slice(0, 700)}`);
      assert(!out.includes('Uszkodzone dane kopii na nośnikach:'), `nothing is damaged here: ${out.slice(0, 700)}`);
      assert(!out.includes('Brak danych kopii na nośnikach:'), `both parts are still on their media: ${out.slice(0, 700)}`);
    }),
  );

  // -- R17/R18 - parts that belong to another version, under this one's names ---
  //
  // The last cause a failed restore can have and the only one no layer pinned:
  // a part in perfect condition that simply is not the part that was asked for.
  // Two versions are pushed, then v2's parts are moved over v1's under the same
  // names - the shape left behind by a rescue by hand, a sync script pointed at
  // the wrong source, or a medium restored from the wrong snapshot. Each part is
  // moved whole, so every checksum it carries still verifies.
  //
  // Both media are healthy and every byte on them is intact, so neither of the
  // sentences this suite already pins may appear. The parts are unencrypted, so
  // a word about a password would send the operator after a secret that is not
  // in play at all.
  //
  // These two are the EN/PL pair for the sentence itself: a key present in one
  // language and not the other, or one carrying the other language's text, is a
  // regression the assertions on medium names alone would not see.
  const strangerVaultDir = path.join(tmpBase, 'stranger-vault');
  const dirA = path.join(tmpBase, 'dirA');
  const dirB = path.join(tmpBase, 'dirB');
  const dirC = path.join(tmpBase, 'dirC');
  const strangerVaultName = 'stranger-vault';
  const strangerShard = (dir: string, index: number, version: number): string => path.join(dir, strangerVaultName, `shard_${index}.bfs.${version}`);

  tests.push(
    await runTest('R17', 'failed pull names the media holding a part of another version (EN)', async () => {
      await initTestVault(
        strangerVaultDir,
        strangerVaultName,
        [
          { id: 'm1', dir: dirA },
          { id: 'm2', dir: dirB },
          { id: 'm3', dir: dirC },
        ],
        ['--no-enc', '--no-compress'],
      );
      const first = runBfs(['push'], strangerVaultDir);
      assert(first.status === 0, `push exit ${first.status ?? 'null'}\n${first.stdout}\n${first.stderr}`);

      await fs.writeFile(path.join(strangerVaultDir, 'hello.txt'), 'a different world entirely\n');
      const second = runBfs(['push', '--new'], strangerVaultDir);
      assert(second.status === 0, `second push exit ${second.status ?? 'null'}\n${second.stdout}\n${second.stderr}`);

      // Two of the three parts of v1 are replaced by v2's, leaving only one that
      // belongs to the version being restored - below what a restore needs.
      await fs.copyFile(strangerShard(dirA, 0, 2), strangerShard(dirA, 0, 1));
      await fs.copyFile(strangerShard(dirB, 1, 2), strangerShard(dirB, 1, 1));

      const r = runBfs(['--lang', 'en', 'pull', '--version', '1', '--force', '--yes'], strangerVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with only one part of this version, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Backup data belonging to another version or another backup, on: m1, m2.'), `the closing sentence must name both media under this cause: ${out.slice(0, 700)}`);
      assert(out.includes('does not belong to this version of the backup'), `each medium must be named as it is skipped: ${out.slice(0, 700)}`);
      assert(!out.includes('Damaged backup data on:'), `the parts are whole - repairing them fixes nothing: ${out.slice(0, 700)}`);
      assert(!out.includes('Backup data missing on:'), `the parts are on their media: ${out.slice(0, 700)}`);
      assert(!out.includes('Storage not reachable:'), `both media answered: ${out.slice(0, 700)}`);
      assert(!out.includes('the password is wrong'), `this backup is not encrypted - no password is in play: ${out.slice(0, 700)}`);
      // The per-medium notices, which the closing sentence does not cover: a
      // refusal signalled by throwing inside the download loop is filed as an
      // absent file by default, and that is one of the two readings the closing
      // sentence exists to keep apart.
      assert(!out.includes('is damaged - skipping it'), `a part in sound condition must not be called damaged: ${out.slice(0, 700)}`);
      assert(!out.includes('missing on storage'), `a part sitting on its medium must not be called missing: ${out.slice(0, 700)}`);
    }),
  );

  tests.push(
    await runTest('R18', 'failed pull names the media holding a part of another version (PL)', () => {
      const r = runBfs(['--lang', 'pl', 'pull', '--version', '1', '--force', '--yes'], strangerVaultDir, undefined, langEnv);
      assert(r.status !== 0, `pull should fail with only one part of this version, got exit ${r.status ?? 'null'}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Dane kopii należące do innej wersji lub innej kopii zapasowej, na nośnikach: m1, m2.'), `the closing sentence must name both media under this cause: ${out.slice(0, 700)}`);
      assert(out.includes('nie należą do tej wersji kopii'), `each medium must be named as it is skipped: ${out.slice(0, 700)}`);
      assert(!out.includes('Uszkodzone dane kopii na nośnikach:'), `the parts are whole - repairing them fixes nothing: ${out.slice(0, 700)}`);
      assert(!out.includes('Brak danych kopii na nośnikach:'), `the parts are on their media: ${out.slice(0, 700)}`);
      assert(!out.includes('Nośniki nieosiągalne:'), `both media answered: ${out.slice(0, 700)}`);
      assert(!out.includes('błędne hasło'), `this backup is not encrypted - no password is in play: ${out.slice(0, 700)}`);
      assert(!out.includes('są uszkodzone - pomijam'), `a part in sound condition must not be called damaged: ${out.slice(0, 700)}`);
      assert(!out.includes('Dane kopii brakują na nośniku'), `a part sitting on its medium must not be called missing: ${out.slice(0, 700)}`);
    }),
  );

  // -- R19 - an encrypted backup, where the stranger takes the salt with it -----
  //
  // The size and the KDF salt of a version are adopted from the first part that
  // clears its own checksum. A stranger at that index therefore hands the whole
  // version the salt IT was sealed under: the key comes out wrong, and every
  // sound part fails its GCM tag next to it. One misplaced file, and a backup
  // with a spare part reports a wrong password to an operator who typed the
  // right one.
  //
  // Only the parity is needed to carry this, so the restore must go through -
  // that is why this asserts a SUCCEEDING run, unlike R17/R18. No PL twin: the
  // sentence being ruled out here comes from the decryption layer and is not
  // translated, so a second language would assert the same English string.
  const saltVaultDir = path.join(tmpBase, 'salt-vault');
  const dirD = path.join(tmpBase, 'dirD');
  const dirE = path.join(tmpBase, 'dirE');
  const dirF = path.join(tmpBase, 'dirF');
  const saltVaultName = 'salt-vault';
  const saltPassword = 'Secret123!';

  tests.push(
    await runTest('R19', 'encrypted restore survives a part of another version and does not blame the password', async () => {
      const originals = await initTestVault(
        saltVaultDir,
        saltVaultName,
        [
          { id: 'k1', dir: dirD },
          { id: 'k2', dir: dirE },
          { id: 'k3', dir: dirF },
        ],
        ['--enc', '--no-compress'],
      );
      const first = runBfs(['push', '--password', saltPassword], saltVaultDir);
      assert(first.status === 0, `push exit ${first.status ?? 'null'}\n${first.stdout}\n${first.stderr}`);

      await fs.writeFile(path.join(saltVaultDir, 'hello.txt'), 'a different world entirely\n');
      const second = runBfs(['push', '--new', '--password', saltPassword], saltVaultDir);
      assert(second.status === 0, `second push exit ${second.status ?? 'null'}\n${second.stdout}\n${second.stderr}`);

      // Every push draws a fresh salt, so v2's part is sealed under a different
      // key even though the password never changed.
      await fs.copyFile(path.join(dirD, saltVaultName, 'shard_0.bfs.2'), path.join(dirD, saltVaultName, 'shard_0.bfs.1'));

      const r = runBfs(['--lang', 'en', 'pull', '--version', '1', '--force', '--yes', '--password', saltPassword], saltVaultDir, undefined, langEnv);
      const out = r.stdout + r.stderr;
      assert(r.status === 0, `the parity covers one refused part, so the restore must go through: exit ${r.status ?? 'null'}\n${out.slice(0, 700)}`);
      assert(out.includes('Backup data on "k1" does not belong to this version of the backup'), `the medium holding a part of another version must be named: ${out.slice(0, 700)}`);
      // The restore came through, so the operator also has to hear what it cost:
      // that medium no longer carries a usable piece of this version.
      assert(out.includes('Pool degraded:') && out.includes('belongs elsewhere'), `a degraded restore must say the redundancy is gone: ${out.slice(0, 700)}`);
      assert(!out.includes('wrong key'), `the password was right - blaming it hides the medium at fault: ${out.slice(0, 700)}`);
      assert(!out.includes('the password is wrong'), `the password was right - blaming it hides the medium at fault: ${out.slice(0, 700)}`);
      assert(!out.includes('is damaged - skipping it'), `the part is whole, only foreign: ${out.slice(0, 700)}`);
      assert(!out.includes('missing on storage'), `the part is on its medium: ${out.slice(0, 700)}`);
      // A restore that exits 0 has proved nothing about the bytes it wrote. The
      // whole point of refusing the stranger is that the version still comes
      // back intact off the parity, so that is what gets checked.
      await verifyShaHashes(saltVaultDir, originals, 'after restoring past a foreign part');
    }),
  );

  await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});

  return { name: 'Suite R - verify verdicts (payload integrity, named causes)', tests };
}
