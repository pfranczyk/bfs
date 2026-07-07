import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { streamToBuffer } from '../../src/core/hash.js';
import { FtpProvider } from '../../src/providers/ftp.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { assert, runBfs, runTest, skipTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// ─── Suite L — FTP provider (requires BFS_FTP_TEST=1 + Docker FTP server) ──

const FTP_ENABLED = process.env.BFS_FTP_TEST === '1';
const SKIP_REASON = 'BFS_FTP_TEST not set. Run: npm run smoke:ftp (starts Docker FTP server automatically)';

// FTP connection params — Docker defaults override-able via env vars for
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
    tests.push(skipTest('L1', 'bfs init z FTP providerem', SKIP_REASON));
    tests.push(skipTest('L2', 'bfs push do FTP', SKIP_REASON));
    tests.push(skipTest('L3', 'bfs pull z FTP', SKIP_REASON));
    tests.push(skipTest('L4', 'FTP binary integrity — 8 MB CR/LF/CRLF pattern roundtrip', SKIP_REASON));
    tests.push(skipTest('L5', 'bfs verify — connection chatter silent without --debug', SKIP_REASON));
    tests.push(skipTest('L6', 'bfs verify --debug — connection chatter visible on stderr', SKIP_REASON));
    tests.push(skipTest('L7', 'bfs recovery z FTP via --bootstrap', SKIP_REASON));
    return { name: 'Suite L — FTP provider', tests };
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

    // L1 — init with 2 local + 1 FTP provider (2+1 scheme)
    tests.push(
      await runTest('L1', 'bfs init z FTP providerem', async () => {
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

    // L2 — push to FTP
    tests.push(
      await runTest('L2', 'bfs push do FTP', async () => {
        const r = runBfs(['push'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      }),
    );

    // L3 — pull from FTP
    tests.push(
      await runTest('L3', 'bfs pull z FTP', async () => {
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

    // L4 — FTP binary integrity probe.
    // Reproduces the 2026-04-20 incident where an 8 MB shard uploaded via
    // FTP was silently truncated (CR bytes stripped) and push still
    // reported success. The mock-based unit test can't catch this — only
    // a real FTP server can. If TYPE I isn't active or the server transforms
    // content, the post-upload verify in FtpProvider.upload() now throws.
    tests.push(
      await runTest('L4', 'FTP binary integrity — 8 MB CR/LF/CRLF pattern roundtrip', async () => {
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
          assert(downloaded.equals(payload), 'byte-for-byte mismatch after FTP roundtrip — ' + 'server is likely running ASCII mode or some transform');
        } finally {
          await provider.delete(ref).catch(() => {});
        }
      }),
    );

    // L5 — verify must stay quiet without --debug.
    // Regression for the user-reported scenario where verify against an FTP
    // provider printed "FTP connecting to host:port" three times per shard
    // before showing the result table. The connect log now routes through
    // io.debug() and stays silenced unless --debug is on.
    tests.push(
      await runTest('L5', 'bfs verify — connection chatter silent without --debug', async () => {
        const r = runBfs(['verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(!combined.includes('FTP connecting'), `Expected no "FTP connecting" output, got:\n${combined}`);
      }),
    );

    // L6 — verify with --debug surfaces the connection chatter on stderr.
    tests.push(
      await runTest('L6', 'bfs verify --debug — connection chatter visible on stderr', async () => {
        const r = runBfs(['--debug', 'verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(r.stderr.includes('FTP connecting'), `Expected "FTP connecting" on stderr with --debug.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(!r.stdout.includes('FTP connecting'), `"FTP connecting" must go to stderr, not stdout.\nstdout: ${r.stdout}`);
      }),
    );

    // L7 — Recovery via --bootstrap with FTP credentials.
    // Direct regression for the user-reported "530 Login incorrect" bug:
    // before the refactor, recovery's parseProviderPath ignored FTP user,
    // password and port — only host was passed. With --bootstrap, every
    // adapter flag reaches FtpProvider.configureFromFlags, so FTP can
    // authenticate and rebuild .bfs/ from the existing shards.
    //
    // --trust-locations skips the host-gate confirmation; the non-interactive
    // harness cannot answer it, so without the flag recovery rebuilds nothing.
    tests.push(
      await runTest('L7', 'bfs recovery z FTP via --bootstrap', async () => {
        // Wipe restoreDir to simulate disaster — only providers retain shards.
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

    // Without --trust-locations the host-gate confirmation goes unanswered, so it
    // refuses and rebuilds nothing. The cancelled prompt exits 0, so the refusal
    // shows as the missing manifest, not a non-zero exit.
    tests.push(
      await runTest('L7b', 'bfs recovery z FTP bez --trust-locations → host-gate nie odbudowuje', async () => {
        await fs.rm(restoreDir, { recursive: true, force: true });
        await fs.mkdir(restoreDir, { recursive: true });

        const r = runBfs(['recovery', '--provider', 'ftp', '--name', 'ftp-test-vault', '--bootstrap', FTP_FLAGS], restoreDir);

        const manifestPath = path.join(restoreDir, '.bfs', 'manifests', 'v001.json');
        const manifestExists = await fs
          .stat(manifestPath)
          .then(() => true)
          .catch(() => false);
        assert(!manifestExists, `host-gate must block recovery without --trust-locations, but the manifest was rebuilt:\n${r.stdout}\n${r.stderr}`);
      }),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  return { name: 'Suite L — FTP provider', tests };
}
