import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { streamToBuffer } from '../../src/core/hash.js';
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { VaultConfig, VaultState, VersionManifest } from '../../src/types/index.js';
import { VersionHealth } from '../../src/types/index.js';
import { assert, runBfs, runTest, skipTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { fileExists, readJson } from '../smoke-vault.js';

// --- Suite L - FTP provider (requires BFS_FTP_TEST=1 + Docker FTP server) --

const FTP_ENABLED = process.env.BFS_FTP_TEST === '1';
const SKIP_REASON = 'BFS_FTP_TEST not set. Run: npm run smoke:ftp (starts Docker FTP server automatically)';

// FTP connection params - Docker defaults override-able via env vars for
// running against an external FTP server.
const FTP_HOST = process.env.BFS_FTP_HOST ?? 'localhost';
const FTP_PORT = Number(process.env.BFS_FTP_PORT ?? '21');
const FTP_USER = process.env.BFS_FTP_USER ?? 'bfsuser';
const FTP_PASSWORD = process.env.BFS_FTP_PASSWORD ?? 'bfspass';
const FTP_PATH = process.env.BFS_FTP_PATH ?? '/ftp/bfsuser';
const FTP_SECURE = process.env.BFS_FTP_SECURE === 'true';
const FTP_FLAGS = `--host ${FTP_HOST} --port ${FTP_PORT} --user ${FTP_USER} --password ${FTP_PASSWORD} --path ${FTP_PATH} --secure ${FTP_SECURE}`;

export async function suiteL(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  if (!FTP_ENABLED) {
    tests.push(skipTest('L1', 'bfs init with an FTP provider', SKIP_REASON));
    tests.push(skipTest('L2', 'bfs push to FTP', SKIP_REASON));
    tests.push(skipTest('L3', 'bfs pull from FTP', SKIP_REASON));
    tests.push(skipTest('L4', 'FTP binary integrity - 8 MB CR/LF/CRLF pattern roundtrip', SKIP_REASON));
    tests.push(skipTest('L5', 'bfs verify - connection chatter silent without --debug', SKIP_REASON));
    tests.push(skipTest('L6', 'bfs verify --debug - connection chatter visible on stderr', SKIP_REASON));
    tests.push(skipTest('L7', 'bfs recovery from FTP via --bootstrap', SKIP_REASON));
    tests.push(skipTest('L7b', 'bfs recovery from FTP without --trust-locations leaves the locations unconfirmed', SKIP_REASON));
    return { name: 'Suite L - FTP provider', tests };
  }

  // Real tests: require Docker FTP server on localhost:21 (bfsuser/bfspass)
  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-l-${Date.now()}`);
  const vaultDir = path.join(tmpBase, 'vault');
  const restoreDir = path.join(tmpBase, 'restore');
  const localP1 = path.join(tmpBase, 'p1');
  const localP2 = path.join(tmpBase, 'p2');

  try {
    await Promise.all([vaultDir, restoreDir, localP1, localP2].map((d) => fs.mkdir(d, { recursive: true })));

    // Create test files
    await fs.writeFile(path.join(vaultDir, 'hello.txt'), 'Hello FTP!');
    await fs.writeFile(path.join(vaultDir, 'data.bin'), Buffer.alloc(128, 42));

    // L1 - init with 2 local + 1 FTP provider (2+1 scheme)
    tests.push(
      await runTest('L1', 'bfs init with an FTP provider', async () => {
        const args = [
          'init',
          'ftp-test-vault',
          '--ci',
          '--data-shards',
          '2',
          '--parity-shards',
          '1',
          '--provider',
          `local:p1 --path ${localP1}`,
          '--provider',
          `local:p2 --path ${localP2}`,
          '--provider',
          `ftp:ftp1 ${FTP_FLAGS}`,
          '--no-enc',
        ];
        const r = runBfs(args, vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const cfg = await readJson<{ providers: Array<{ type: string }> }>(path.join(vaultDir, '.bfs', 'config.json'));
        const ftpProviders = cfg.providers.filter((p) => p.type === 'ftp');
        assert(ftpProviders.length === 1, `Expected 1 FTP provider, got ${ftpProviders.length}`);
      }),
    );

    // L2 - push to FTP
    tests.push(
      await runTest('L2', 'bfs push to FTP', async () => {
        const r = runBfs(['push'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      }),
    );

    // L3 - pull from FTP
    tests.push(
      await runTest('L3', 'bfs pull from FTP', async () => {
        // Clear vault files (keep .bfs/)
        const entries = await fs.readdir(vaultDir);
        for (const e of entries) {
          if (e !== '.bfs') {
            await fs.rm(path.join(vaultDir, e), { recursive: true, force: true });
          }
        }

        const r = runBfs(['pull', '--force'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        // Verify files restored
        const hello = await fs.readFile(path.join(vaultDir, 'hello.txt'), 'utf8');
        assert(hello === 'Hello FTP!', `hello.txt content: ${hello}`);
      }),
    );

    // L4 - FTP binary integrity probe.
    // Reproduces the 2026-04-20 incident where an 8 MB shard uploaded via
    // FTP was silently truncated (CR bytes stripped) and push still
    // reported success. The mock-based unit test can't catch this - only
    // a real FTP server can. If TYPE I isn't active or the server transforms
    // content, the post-upload verify in FtpProvider.upload() now throws.
    tests.push(
      await runTest('L4', 'FTP binary integrity - 8 MB CR/LF/CRLF pattern roundtrip', async () => {
        const size = 8 * 1024 * 1024;
        const payload = Buffer.alloc(size);
        const pattern = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0xff, 0x7f, 0x80];
        for (let i = 0; i < size; i++) {
          payload[i] = pattern[i % pattern.length];
        }

        const { io } = createMockProviderIO();
        const provider = new FtpProvider({ id: 'smoke-l4', type: 'ftp', adapterPackage: null, config: { host: FTP_HOST, port: FTP_PORT, user: FTP_USER, password: FTP_PASSWORD, path: FTP_PATH, secure: FTP_SECURE } }, io);
        provider.setVaultName('ftp-integrity-smoke');

        // Must carry the production `shard_` prefix. After STOR, upload() removes
        // the matching `hdr_` sidecar, and sidecarFilename() only rewrites a
        // leading `shard_`; a name without it maps to itself, so upload() would
        // delete the file it just stored and the download below would 550.
        const fileName = `shard_0.bfs.${Date.now()}`;
        const ref = await provider.upload(fileName, Readable.from(payload), payload.length);

        try {
          const downloaded = await streamToBuffer(await provider.download(ref));
          assert(downloaded.length === payload.length, `size mismatch: uploaded ${payload.length} B, downloaded ${downloaded.length} B`);
          assert(downloaded.equals(payload), 'byte-for-byte mismatch after FTP roundtrip - ' + 'server is likely running ASCII mode or some transform');
        } finally {
          await provider.delete(ref).catch(() => {});
        }
      }),
    );

    // L5 - verify must stay quiet without --debug.
    // Regression for the user-reported scenario where verify against an FTP
    // provider printed "FTP connecting to host:port" three times per shard
    // before showing the result table. The connect log now routes through
    // io.debug() and stays silenced unless --debug is on.
    tests.push(
      await runTest('L5', 'bfs verify - connection chatter silent without --debug', async () => {
        const r = runBfs(['verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(!combined.includes('FTP connecting'), `Expected no "FTP connecting" output, got:\n${combined}`);
      }),
    );

    // L6 - verify with --debug surfaces the connection chatter on stderr.
    tests.push(
      await runTest('L6', 'bfs verify --debug - connection chatter visible on stderr', async () => {
        const r = runBfs(['--debug', 'verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(r.stderr.includes('FTP connecting'), `Expected "FTP connecting" on stderr with --debug.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(!r.stdout.includes('FTP connecting'), `"FTP connecting" must go to stderr, not stdout.\nstdout: ${r.stdout}`);
      }),
    );

    // L7 - Recovery via --bootstrap with FTP credentials. Every adapter flag in
    // the --bootstrap spec reaches FtpProvider.configureFromFlags - user,
    // password and port, not the host alone - so the bootstrap storage
    // authenticates and .bfs/ is rebuilt from the shards already sitting on it.
    //
    // --trust-locations pre-approves the locations read out of the shard header,
    // so the bootstrap credential is offered to the siblings in that map and the
    // run needs no operator: every part stays reachable and the rebuilt state is
    // marked confirmed. L7b covers the same run without the flag.
    tests.push(
      await runTest('L7', 'bfs recovery from FTP via --bootstrap', async () => {
        // Wipe restoreDir to simulate disaster - only providers retain shards.
        await fs.rm(restoreDir, { recursive: true, force: true });
        await fs.mkdir(restoreDir, { recursive: true });

        const r = runBfs(['recovery', '--provider', 'ftp', '--name', 'ftp-test-vault', '--bootstrap', FTP_FLAGS, '--trust-locations'], restoreDir);
        assert(r.status === 0, `recovery exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const manifestPath = path.join(restoreDir, '.bfs', 'manifests', 'v001.json');
        const manifestExists = await fs
          .stat(manifestPath)
          .then(() => true)
          .catch(() => false);
        assert(manifestExists, `expected .bfs/manifests/v001.json after recovery, missing in:\n${r.stdout}\n${r.stderr}`);
      }),
    );

    // Without --trust-locations nobody has approved the locations that came out
    // of the shard header, so no credential is offered to the entries in it. The
    // local siblings need none and connect anyway; the FTP entry, whose password
    // was stripped from the map at push time, stays without one - which is why
    // the version comes back degraded instead of whole. The guarantee is
    // `locations_confirmed: false`, which push and provider-remove stop on until
    // the operator confirms the locations, and the rebuilt config carrying no
    // credential is the other half of it. Each of the three is mirrored by the
    // same run with the flag, which flips it, so none of them passes on a run
    // that merely fell over early.
    tests.push(
      await runTest('L7b', 'bfs recovery from FTP without --trust-locations leaves the locations unconfirmed', async () => {
        await fs.rm(restoreDir, { recursive: true, force: true });
        await fs.mkdir(restoreDir, { recursive: true });

        const r = runBfs(['recovery', '--provider', 'ftp', '--name', 'ftp-test-vault', '--bootstrap', FTP_FLAGS], restoreDir);
        assert(r.status === 0, `recovery exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        // Guard the reads: the very regression this test watches for is "exit 0
        // with nothing written", and a bare ENOENT would hide the CLI output that
        // says why.
        const statePath = path.join(restoreDir, '.bfs', 'state.json');
        const manifestPath = path.join(restoreDir, '.bfs', 'manifests', 'v001.json');
        assert(await fileExists(statePath), `recovery reported success but wrote no state.json:\n${r.stdout}\n${r.stderr}`);
        assert(await fileExists(manifestPath), `recovery reported success but rebuilt no manifest:\n${r.stdout}\n${r.stderr}`);

        const state = await readJson<VaultState>(statePath);
        assert(state.locations_confirmed === false, `expected locations_confirmed=false without --trust-locations, got ${JSON.stringify(state.locations_confirmed)}\n${r.stdout}\n${r.stderr}`);

        const manifest = await readJson<VersionManifest>(manifestPath);
        assert(manifest.health === VersionHealth.Degraded, `expected the version degraded while the FTP entry stays without a credential, got "${manifest.health}"\n${r.stdout}\n${r.stderr}`);

        const cfg = await readJson<VaultConfig>(path.join(restoreDir, '.bfs', 'config.json'));
        const carryingSecret = providersCarryingPassword(cfg);
        assert(carryingSecret.length === 0, `the bootstrap credential must not be written into a location nobody approved, but it landed on: ${carryingSecret.join(', ')}`);

        // The same run with the flag - without this half, each assertion above
        // would also hold for a recovery that fell over for an unrelated reason.
        await fs.rm(restoreDir, { recursive: true, force: true });
        await fs.mkdir(restoreDir, { recursive: true });

        const rt = runBfs(['recovery', '--provider', 'ftp', '--name', 'ftp-test-vault', '--bootstrap', FTP_FLAGS, '--trust-locations'], restoreDir);
        assert(rt.status === 0, `recovery --trust-locations exit ${rt.status ?? 'null'}\nstdout: ${rt.stdout}\nstderr: ${rt.stderr}`);

        const trustedState = await readJson<VaultState>(statePath);
        assert(trustedState.locations_confirmed === true, `expected locations_confirmed=true with --trust-locations, got ${JSON.stringify(trustedState.locations_confirmed)}\n${rt.stdout}\n${rt.stderr}`);

        const trustedManifest = await readJson<VersionManifest>(manifestPath);
        assert(trustedManifest.health === VersionHealth.Healthy, `with the locations approved every storage is reachable, so the version must come back healthy, got "${trustedManifest.health}"\n${rt.stdout}\n${rt.stderr}`);

        const trustedCfg = await readJson<VaultConfig>(path.join(restoreDir, '.bfs', 'config.json'));
        const trustedCarrying = providersCarryingPassword(trustedCfg);
        assert(trustedCarrying.includes('ftp1'), `with the locations approved the credential must reach the FTP storage, but no storage carries one (carrying: ${trustedCarrying.join(', ') || '(none)'})`);
      }),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  return { name: 'Suite L - FTP provider', tests };
}

/**
 * Names the storages whose rebuilt connection config carries a password. The
 * field is stripped from the location map at push time, so it can only be there
 * because recovery collected it - which is exactly what the approval of the
 * recovered locations decides.
 */
function providersCarryingPassword(config: VaultConfig): string[] {
  return config.providers.filter((p) => p.config.password !== undefined).map((p) => p.id);
}
