import fs from 'node:fs/promises';
import path from 'node:path';
// Side-effect: registers "local" type in ProviderRegistry.
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init } from '../../src/vault/vault-manager.js';
import { assert, runBfs, runTest } from '../smoke-runner.js';
import type { SmokeContext, SuiteResult, TestResult } from '../smoke-types.js';
import { readJson, sha256 } from '../smoke-vault.js';

// ─── Suite O — pull --allow-missing-adapters with a missing external adapter ──
//
// Verifies the CHANGELOG [0.5.0] promise: `bfs pull --allow-missing-adapters`
// lets Reed-Solomon decoding proceed with whichever providers remain reachable.
// A vault is pushed across 3 local providers, then config.json is mutated so one
// provider uses an unregistered external type (ghost-ssh + adapterPackage). Its
// shard file stays on disk. `bfs pull --allow-missing-adapters` must skip that
// provider, RS-decode from the remaining N=2, exit 0 and restore the files.
//
// Bug guarded: providerRegistry.create() on the unregistered type was invoked
// outside the download try/catch → BfsError("Unknown provider type") crashed the
// whole pull instead of degrading gracefully.

export async function suiteO(ctx: SmokeContext): Promise<SuiteResult> {
  const tests: TestResult[] = [];
  const oTmpDir = path.join(ctx.sourceDir, 'o-missing-adapter');
  const oVaultDir = path.join(oTmpDir, 'vault');
  const oP1Dir = path.join(oTmpDir, 'p1');
  const oP2Dir = path.join(oTmpDir, 'p2');
  const oP3Dir = path.join(oTmpDir, 'p3');
  // Isolated XDG_CONFIG_HOME → no global settings → default lang 'en'.
  const oLangDir = path.join(oTmpDir, 'lang-config');
  const oEnv: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: oLangDir };

  const cfgPath = path.join(oVaultDir, '.bfs', 'config.json');
  const helloPath = path.join(oVaultDir, 'hello.txt');
  const helloContent = 'Hello, missing adapter!';
  const helloHash = sha256(Buffer.from(helloContent));

  // ── O0: Setup vault 2/1, push v1, then mutate config to external-missing ──

  tests.push(
    await runTest('O0', 'setup: vault O + push + mutate config (external-missing)', async () => {
      await fs.mkdir(oVaultDir, { recursive: true });
      await fs.mkdir(oP1Dir, { recursive: true });
      await fs.mkdir(oP2Dir, { recursive: true });
      await fs.mkdir(oP3Dir, { recursive: true });
      await fs.mkdir(oLangDir, { recursive: true });

      await fs.writeFile(helloPath, helloContent);

      const { io } = createMockProviderIO();
      const providers: ProviderConfig[] = [
        { id: 'op1', type: 'local', adapterPackage: null, config: { path: oP1Dir } },
        { id: 'op2', type: 'local', adapterPackage: null, config: { path: oP2Dir } },
        { id: 'op3', type: 'local', adapterPackage: null, config: { path: oP3Dir } },
      ];
      await init(oVaultDir, { vault_name: 'o-vault', scheme: { data_shards: 2, parity_shards: 1 }, encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' }, push_mode: PushMode.NewVersion, providers, io });

      const pushResult = runBfs(['push'], oVaultDir, undefined, oEnv);
      assert(pushResult.status === 0, `expected push exit 0, got ${pushResult.status}\n${pushResult.stdout}\n${pushResult.stderr}`);

      // Mutate config AFTER push: op3 becomes an unregistered external type.
      // Its shard file (shard_2.bfs.1) stays untouched on disk.
      const cfg = await readJson<VaultConfig>(cfgPath);
      const ghost = cfg.providers.find((p) => p.id === 'op3');
      assert(ghost !== undefined, 'provider op3 not found in config');
      if (ghost) {
        ghost.type = 'ghost-ssh';
        (ghost as { adapterPackage: string }).adapterPackage = 'bfs-adapter-ghost@1.0.0';
      }
      await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2));

      // Remove the restored file so the pull has to actually rewrite it.
      await fs.rm(helloPath, { force: true });
    }),
  );

  // ── O1: pull WITHOUT the flag → preflight aborts (contrast, already works) ─

  tests.push(
    await runTest('O1', 'bfs pull (no flag) — aborts on missing external adapter', async () => {
      const r = runBfs(['pull', '--force'], oVaultDir, undefined, oEnv);
      assert(r.status !== 0, `expected non-zero exit without --allow-missing-adapters, got ${r.status}`);
      const out = r.stdout + r.stderr;
      // Missing-adapter install hint mentions the recorded package spec.
      assert(/ghost-ssh|bfs-adapter-ghost|allow-missing-adapters/i.test(out), `expected missing-adapter hint: ${out.slice(0, 400)}`);
    }),
  );

  // ── O2: pull WITH the flag → skip missing provider, restore from N=2 ──────

  tests.push(
    await runTest('O2', 'bfs pull --allow-missing-adapters — restores from remaining N', async () => {
      const r = runBfs(['pull', '--force', '--allow-missing-adapters'], oVaultDir, undefined, oEnv);
      const out = r.stdout + r.stderr;
      // The bug surfaced as "Unknown provider type" crashing the whole pull.
      assert(!/Unknown provider type/i.test(out), `pull crashed with "Unknown provider type" instead of skipping: ${out.slice(0, 600)}`);
      assert(r.status === 0, `expected exit 0 with --allow-missing-adapters, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

      const restored = await fs.readFile(helloPath).catch(() => null);
      assert(restored !== null, 'hello.txt was not restored');
      assert(restored !== null && sha256(restored) === helloHash, 'restored hello.txt SHA-256 mismatch');
    }),
  );

  return { name: 'Suite O — pull --allow-missing-adapters (external-missing)', tests };
}
