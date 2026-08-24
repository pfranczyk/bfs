import fs from 'node:fs/promises';
import path from 'node:path';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { readManifest } from '../../src/vault/manifest.js';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists, hashDir, initTestVault, verifyShaHashes } from '../smoke-vault.js';

// --- Suite D - Pull + integrity -----------------------------------------------

export async function suiteD(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const fileCount = ctx.originalHashes.size;

  tests.push(
    await runTest('D1', 'delete files from sourceDir', async () => {
      const entries = await fs.readdir(ctx.vaultDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.bfs') continue;
        const full = path.join(ctx.vaultDir, entry.name);
        await fs.rm(full, { recursive: true });
      }
      const remaining = await fs.readdir(ctx.vaultDir);
      const nonBfs = remaining.filter((f) => f !== '.bfs');
      assert(nonBfs.length === 0, `expected empty dir, got: ${nonBfs.join(', ')}`);
    }),
  );

  tests.push(
    await runTest('D2', 'bfs pull --force', () => {
      const r = runBfs(['pull', '--force'], ctx.vaultDir);
      assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }),
  );

  tests.push(
    await runTest('D3', 'SHA-256 of restored files', async () => {
      await verifyShaHashes(ctx.vaultDir, ctx.originalHashes, 'after pull');
    }),
  );

  tests.push(
    await runTest('D4', 'file count after pull', async () => {
      const restored = await hashDir(ctx.vaultDir);
      // Exclude .bfs/ metadata files
      const restoredCount = [...restored.keys()].filter((k) => !k.startsWith('.bfs')).length;
      assert(restoredCount === fileCount, `expected ${fileCount} files, got ${restoredCount}`);
    }),
  );

  // -- Degraded pull (missing shard_0) ---------------------------------------
  // Smoke-vault scheme: 2 data + 1 parity -> loss of 1 shard tolerated by RS.
  // Provider p1 holds shard_0 (index 0 -> first registered provider).

  tests.push(
    await runTest('D5', 'delete shard_0.bfs.1 - simulate p1 failure', async () => {
      const shardPath = path.join(ctx.provider1Dir, 'smoke-vault', 'shard_0.bfs.1');
      await fs.unlink(shardPath);
      assert(!(await fileExists(shardPath)), `shard_0.bfs.1 still exists after deletion`);
    }),
  );

  tests.push(
    await runTest('D6', 'bfs pull --force (degraded) - exit 0, clean warn message', () => {
      const r = runBfs(['pull', '--force'], ctx.vaultDir);
      assert(r.status === 0, `expected exit 0 for degraded pull, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const combined = r.stdout + r.stderr;
      assert(/not accessible.*skipping|missing on storage.*skipping|niedost[eę]pny.*pomijam|brakuj[aą] na no[sś]niku.*pomijam/i.test(combined), `expected provider-unreachable or file-missing message in output: ${combined.slice(0, 400)}`);
      assert(!combined.includes('ENOENT'), `output must not contain raw ENOENT chain: ${combined.slice(0, 400)}`);
    }),
  );

  tests.push(
    await runTest('D7', 'SHA-256 of files after degraded pull', async () => {
      await verifyShaHashes(ctx.vaultDir, ctx.originalHashes, 'after degraded pull');
    }),
  );

  // -- D8: file mode + mtime restored after pull (compressed, the default path) --
  // CLI-layer regression net for the v2 per-file metadata (mode/mtime carried in
  // the file-table entry). A file is stamped with a
  // known mode + mtime, pushed and pulled through the real `bfs` process, then its
  // metadata is checked on disk. mtime is asserted on every OS; mode on POSIX only
  // (chmod is a no-op on Windows). Its own isolated vault so it never perturbs the
  // shared ctx roundtrip above.
  tests.push(
    await runTest('D8', 'file mode + mtime restored after pull (compressed)', async () => {
      const metaVault = path.join(ctx.sourceDir, 'meta-vault');
      const providers = [
        { id: 'meta-p1', dir: path.join(ctx.sourceDir, 'meta-p1') },
        { id: 'meta-p2', dir: path.join(ctx.sourceDir, 'meta-p2') },
        { id: 'meta-p3', dir: path.join(ctx.sourceDir, 'meta-p3') },
      ];
      await initTestVault(metaVault, 'meta-vault', providers, ['--no-enc']);

      const target = path.join(metaVault, 'hello.txt');
      const knownMtime = new Date('2021-06-15T12:00:00.000Z');
      if (process.platform !== 'win32') await fs.chmod(target, 0o750);
      await fs.utimes(target, knownMtime, knownMtime);
      const wantMtime = Math.round((await fs.stat(target)).mtimeMs / 1000);

      const rp = runBfs(['push'], metaVault);
      assert(rp.status === 0, `push exit ${rp.status ?? 'null'}\n${rp.stdout}\n${rp.stderr}`);

      const rl = runBfs(['pull', '--force'], metaVault);
      assert(rl.status === 0, `pull exit ${rl.status ?? 'null'}\n${rl.stdout}\n${rl.stderr}`);

      const stat = await fs.stat(target);
      assert(Math.round(stat.mtimeMs / 1000) === wantMtime, `mtime not restored: expected ${wantMtime}, got ${Math.round(stat.mtimeMs / 1000)}`);
      if (process.platform !== 'win32') {
        assert((stat.mode & 0o777) === 0o750, `mode not restored: expected 750, got ${(stat.mode & 0o777).toString(8)}`);
      }
    }),
  );

  // -- D9/D10: storage recorded in the backup but absent from the configuration --
  // The message names the storage and nothing else - a shard index is internal
  // and must never surface in the UI, so `skipping its part of the backup` is the
  // whole of it. The cause is triggered by renaming a storage in .bfs/config.json:
  // the scheme check counts storages, so the count has to stay at three, while
  // the backup keeps pointing at the old name. Two of three parts remain, so the
  // pull completes and names the cause instead of failing.
  //
  // XDG_CONFIG_HOME is redirected because `--lang` persists the choice in the
  // global settings file, which these tests would otherwise share with the rest
  // of the run.
  //
  // Beside the skip note, the restore owes the operator a second, separate
  // warning: this is the one degradation that can be undone without touching
  // any data, so the warning names the storage the backup records and the
  // command that brings it back. It carries the `Pool degraded:` /
  // `Pula zdegradowana:` opening every other degradation warning uses, which is
  // also what tells the two language runs apart. D11 runs that command for real
  // and proves it leads somewhere.

  const unkLangDir = path.join(ctx.sourceDir, 'unk-lang-config');
  const unkEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: unkLangDir };

  tests.push(
    await runTest('D9', 'pull names an unconfigured storage without a part number (EN)', async () => {
      await fs.mkdir(unkLangDir, { recursive: true });
      const vaultDir = await initVaultWithUnconfiguredStorage(ctx.sourceDir, 'unk-en', unkEnv);
      const r = runBfs(['--lang', 'en', 'pull', '--force'], vaultDir, undefined, unkEnv);
      assert(r.status === 0, `expected exit 0, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Storage "unk-en-p3" is not in the configuration - skipping its part of the backup.'), `expected the storage-only wording in: ${out.slice(0, 400)}`);
      assert(!/skipping (piece )?\d/.test(out), `the message must not render a part number: ${out.slice(0, 400)}`);
      const advice = out.split(/\r?\n/).find((l) => l.includes('bfs repair'));
      if (advice === undefined) throw new Error(`expected a warning recommending \`bfs repair\` in: ${out.slice(0, 400)}`);
      assert(advice.includes('unk-en-p3'), `the advice must name the storage the backup records: ${advice}`);
      assert(advice.includes('Pool degraded'), `the advice must be the English degradation warning: ${advice}`);
    }),
  );

  tests.push(
    await runTest('D10', 'pull names an unconfigured storage without a part number (PL)', async () => {
      await fs.mkdir(unkLangDir, { recursive: true });
      const vaultDir = await initVaultWithUnconfiguredStorage(ctx.sourceDir, 'unk-pl', unkEnv);
      const r = runBfs(['--lang', 'pl', 'pull', '--force'], vaultDir, undefined, unkEnv);
      assert(r.status === 0, `expected exit 0, got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      const out = r.stdout + r.stderr;
      assert(out.includes('Nośnik "unk-pl-p3" nie istnieje w konfiguracji - pomijam jego część kopii.'), `expected the storage-only wording in: ${out.slice(0, 400)}`);
      assert(!/pomijam (część )?\d/.test(out), `the message must not render a part number: ${out.slice(0, 400)}`);
      const advice = out.split(/\r?\n/).find((l) => l.includes('bfs repair'));
      if (advice === undefined) throw new Error(`expected a warning recommending \`bfs repair\` in: ${out.slice(0, 400)}`);
      assert(advice.includes('unk-pl-p3'), `the advice must name the storage the backup records: ${advice}`);
      assert(advice.includes('Pula zdegradowana'), `the advice must be the Polish degradation warning: ${advice}`);
    }),
  );

  // -- D11: the route D9/D10 recommend is one the operator can actually walk --
  //
  // This test passes today, and that is the point of it. D9/D10 pin what the
  // restore has to SAY; D11 pins that what it says leads somewhere - it takes
  // the recommended command, runs it verbatim against the very directory D9
  // pulled, and shows the degradation gone afterwards. The migration form of
  // `bfs repair` renames the configuration entry back to the name the backup
  // records, leaving the storage count and the scheme alone, and re-points the
  // location maps; the next pull then finds every storage it was told about.
  // Should this ever go red, the advice D9/D10 demand has become a dead end and
  // the wording has to change with it.
  tests.push(
    await runTest('D11', 'the recommended `bfs repair` brings the lost storage back', async () => {
      const vaultDir = path.join(ctx.sourceDir, 'unk-en-vault');
      const storageDir = path.join(ctx.sourceDir, 'unk-en-p3');

      // Arrange-check by state, not by wording: exactly one storage the backup
      // records is absent from the configuration. Anchoring this on a message
      // would tie the proof to the phrasing D9 is still waiting for.
      const before = await readConfig(vaultDir);
      if (before === null) throw new Error(`.bfs/config.json missing in ${vaultDir}`);
      const manifest = await readManifest(vaultDir, 1);
      if (manifest === null) throw new Error(`v001 manifest missing in ${vaultDir}`);
      const configured = new Set(before.providers.map((p) => p.id));
      const lost = manifest.shards.map((s) => s.provider_id).filter((id) => !configured.has(id));
      assert(lost.length === 1 && lost[0] === 'unk-en-p3', `expected the backup to record exactly one unconfigured storage (unk-en-p3), got: ${lost.join(', ') || '(none)'}`);

      const rr = runBfs(['--lang', 'en', 'repair', '--version', 'all', 'unk-en-p3-renamed', `local:unk-en-p3 --path ${storageDir}`], vaultDir, undefined, unkEnv);
      assert(rr.status === 0, `repair exit ${rr.status ?? 'null'}\nstdout: ${rr.stdout}\nstderr: ${rr.stderr}`);

      const after = await readConfig(vaultDir);
      if (after === null) throw new Error(`.bfs/config.json missing after repair in ${vaultDir}`);
      assert(
        after.providers.some((p) => p.id === 'unk-en-p3'),
        `expected the configuration to list unk-en-p3 after the repair, got: ${after.providers.map((p) => p.id).join(', ')}`,
      );
      assert(after.providers.length === before.providers.length, `the repair must not change the number of storages: ${before.providers.length} -> ${after.providers.length}`);

      const rp = runBfs(['--lang', 'en', 'pull', '--force'], vaultDir, undefined, unkEnv);
      assert(rp.status === 0, `pull after repair exit ${rp.status ?? 'null'}\nstdout: ${rp.stdout}\nstderr: ${rp.stderr}`);
      const out = rp.stdout + rp.stderr;
      // Deliberately wide: whatever wording the warning settles on, none of it
      // may survive the repair.
      assert(!/not (found )?in (the )?config|nie (istnieje|znaleziony) w konfiguracji/i.test(out), `the restore still reports an unconfigured storage after the repair: ${out.slice(0, 400)}`);
      assert(!out.includes('bfs repair'), `the restore still advises a repair after the repair: ${out.slice(0, 400)}`);
    }),
  );

  return { name: 'Suite D - Pull + integrity', tests };
}

/**
 * Creates an isolated vault (scheme 2+1) with one pushed version, then renames
 * the third storage in `.bfs/config.json`. The manifest still points at the
 * original name, so a pull finds a storage it has no configuration for while
 * the storage count still matches the scheme. The rewrite goes through
 * `writeConfig` so the file keeps the owner-only mode BFS gives it.
 *
 * @param sourceDir - Smoke temp root that holds the vault and provider dirs
 * @param name      - Prefix for the vault dir, vault name and provider names
 * @param env       - Environment for every spawned `bfs` (isolated XDG_CONFIG_HOME)
 * @returns           Path of the created vault directory
 */
async function initVaultWithUnconfiguredStorage(sourceDir: string, name: string, env: NodeJS.ProcessEnv): Promise<string> {
  const vaultDir = path.join(sourceDir, `${name}-vault`);
  const providers = [1, 2, 3].map((i) => ({ id: `${name}-p${i}`, dir: path.join(sourceDir, `${name}-p${i}`) }));
  await initTestVault(vaultDir, `${name}-vault`, providers, ['--no-enc']);

  const rp = runBfs(['push'], vaultDir, undefined, env);
  assert(rp.status === 0, `push exit ${rp.status ?? 'null'}\nstdout: ${rp.stdout}\nstderr: ${rp.stderr}`);

  const cfg = await readConfig(vaultDir);
  if (cfg === null) throw new Error(`.bfs/config.json missing in ${vaultDir}`);
  cfg.providers[2].id = `${name}-p3-renamed`;
  await writeConfig(vaultDir, cfg);

  return vaultDir;
}
