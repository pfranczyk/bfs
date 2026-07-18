import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { streamToBuffer } from '../../src/core/hash.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import { SshProvider } from '../../src/providers/ssh.js';
import { assert, runBfs, runTest, skipTest } from '../smoke-runner.js';
import type { SuiteResult, TestResult } from '../smoke-types.js';
import { readJson } from '../smoke-vault.js';

// ─── Suite Q — SSH/SFTP provider (requires BFS_SSH_TEST=1 + Docker sshd) ──────

const SSH_ENABLED = process.env.BFS_SSH_TEST === '1';
const SKIP_REASON = 'BFS_SSH_TEST not set. Run: npm run smoke:ssh (starts Docker SSH server automatically)';

// SSH connection params — Docker defaults, override-able via env vars for
// running against an external SSH server.
const SSH_HOST = process.env.BFS_SSH_HOST ?? '127.0.0.1';
const SSH_PORT = Number(process.env.BFS_SSH_PORT ?? '2222');
const SSH_USER = process.env.BFS_SSH_USER ?? 'bfsuser';
const SSH_PASSWORD = process.env.BFS_SSH_PASSWORD ?? 'bfspass';
const SSH_BASE = process.env.BFS_SSH_PATH ?? '/config';
const SSH_KEY_PATH = process.env.BFS_SSH_PRIVATE_KEY ?? '';

// Each of the N+K providers gets its own remote sub-path so shards never share a
// directory. --accept-new-host-key trusts the container's ephemeral host key: the
// smoke run pins no fingerprint, and push runs non-interactive (stdin is not a TTY).
const REMOTE_PATHS = [`${SSH_BASE}/q1`, `${SSH_BASE}/q2`, `${SSH_BASE}/q3`];
const VAULT_NAME = 'ssh-smoke-vault';

/** Builds a single `--provider` spec string for a password-auth SSH provider. */
function providerSpec(id: string, remotePath: string): string {
  return `ssh:${id} --host ${SSH_HOST} --port ${SSH_PORT} --user ${SSH_USER} --password ${SSH_PASSWORD} --path ${remotePath} --accept-new-host-key`;
}

/** Fills a buffer with a byte pattern that a naive ASCII/CRLF transform would corrupt. */
function fillProbePattern(buffer: Buffer): void {
  const pattern = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0xff, 0x7f, 0x80];
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = pattern[i % pattern.length];
  }
}

/**
 * Rejects if `p` does not settle within `ms`. The direct-provider probes below
 * have no CLI timeout wrapping them (unlike runBfs), so a stalled SFTP op would
 * hang the whole smoke run forever — this converts it into a clean failure. The
 * SSH write-stream `'finish'`-never-fires hang is exactly such a stall.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

export async function suiteQ(): Promise<SuiteResult> {
  const tests: TestResult[] = [];

  if (!SSH_ENABLED) {
    tests.push(skipTest('Q1', 'bfs init z 3× SSH providerem', SKIP_REASON));
    tests.push(skipTest('Q2', 'bfs push do SSH', SKIP_REASON));
    tests.push(skipTest('Q3', 'bfs pull z SSH', SKIP_REASON));
    tests.push(skipTest('Q4', 'SSH binary integrity — 8 MB CR/LF/CRLF pattern roundtrip', SKIP_REASON));
    tests.push(skipTest('Q5', 'bfs verify — connection chatter silent without --debug', SKIP_REASON));
    tests.push(skipTest('Q6', 'bfs verify --debug — connection chatter visible on stderr', SKIP_REASON));
    tests.push(skipTest('Q7', 'SSH key-auth — upload/download roundtrip via private key', SKIP_REASON));
    tests.push(skipTest('Q8', 'bfs provider edit --accept-new-host-key on ssh → refused offline', SKIP_REASON));
    tests.push(skipTest('Q9', 'bfs provider edit --known-host pins offline (no server contact)', SKIP_REASON));
    return { name: 'Suite Q — SSH/SFTP provider', tests };
  }

  // Real tests: require a Docker sshd on 127.0.0.1:2222 (bfsuser/bfspass + PUBLIC_KEY)
  const tmpBase = path.join(os.tmpdir(), `bfs-smoke-q-${Date.now()}`);
  const vaultDir = path.join(tmpBase, 'vault');

  try {
    await fs.mkdir(vaultDir, { recursive: true });

    // Create test files
    await fs.writeFile(path.join(vaultDir, 'hello.txt'), 'Hello SSH!');
    await fs.writeFile(path.join(vaultDir, 'data.bin'), Buffer.alloc(128, 42));

    // Q1 — init with 3 SSH providers (2+1 scheme, all shards over SFTP).
    // No pre-creation step: init itself creates+verifies each remote base path
    // (probeConnection in vault-manager.init), so a missing dir is provisioned here.
    tests.push(
      await runTest('Q1', 'bfs init z 3× SSH providerem', async () => {
        const args = [
          'init',
          VAULT_NAME,
          '--ci',
          '--data-shards',
          '2',
          '--parity-shards',
          '1',
          '--provider',
          providerSpec('ssh1', REMOTE_PATHS[0]),
          '--provider',
          providerSpec('ssh2', REMOTE_PATHS[1]),
          '--provider',
          providerSpec('ssh3', REMOTE_PATHS[2]),
          '--no-enc',
        ];
        const r = runBfs(args, vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const cfg = await readJson<{ providers: Array<{ type: string }> }>(path.join(vaultDir, '.bfs', 'config.json'));
        const sshProviders = cfg.providers.filter((p) => p.type === 'ssh');
        assert(sshProviders.length === 3, `Expected 3 SSH providers, got ${sshProviders.length}`);
      }),
    );

    // Q2 — push to SSH
    tests.push(
      await runTest('Q2', 'bfs push do SSH', async () => {
        const r = runBfs(['push'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
      }),
    );

    // Q3 — pull from SSH
    tests.push(
      await runTest('Q3', 'bfs pull z SSH', async () => {
        // Clear vault files (keep .bfs/)
        const entries = await fs.readdir(vaultDir);
        for (const e of entries) {
          if (e !== '.bfs') {
            await fs.rm(path.join(vaultDir, e), { recursive: true, force: true });
          }
        }

        const r = runBfs(['pull', '--force'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const hello = await fs.readFile(path.join(vaultDir, 'hello.txt'), 'utf8');
        assert(hello === 'Hello SSH!', `hello.txt content: ${hello}`);
      }),
    );

    // Q4 — SSH binary integrity probe. Mirrors the FTP silent-truncation guard:
    // an 8 MB shard pushed over SFTP must round-trip byte-for-byte. A mock can't
    // catch a transport that drops/rewrites bytes — only a real server can. The
    // post-upload stat in SshProvider.upload() would already throw on a size
    // mismatch; this download-and-compare additionally proves the bytes are intact.
    tests.push(
      await runTest('Q4', 'SSH binary integrity — 8 MB CR/LF/CRLF pattern roundtrip', async () => {
        const size = 8 * 1024 * 1024;
        const payload = Buffer.alloc(size);
        fillProbePattern(payload);

        // interactive=false so the host-key decision takes the non-interactive
        // branch and honours accept_new_host_key instead of prompting.
        const { io } = createMockProviderIO({}, process.cwd(), false);
        const provider = new SshProvider(
          { id: 'smoke-q4', type: 'ssh', adapterPackage: null, config: { host: SSH_HOST, port: SSH_PORT, user: SSH_USER, password: SSH_PASSWORD, path: REMOTE_PATHS[0], auth_method: 'password', accept_new_host_key: true } },
          io,
        );
        provider.setVaultName('ssh-integrity-smoke');

        // Must carry the production `shard_` prefix — upload() removes the matching
        // `hdr_` sidecar, and sidecarFilename() only rewrites a leading `shard_`.
        const fileName = `shard_0.bfs.${Date.now()}`;
        const ref = await withTimeout(provider.upload(fileName, Readable.from(payload), payload.length), 45_000, 'Q4 upload');

        try {
          const downloaded = await streamToBuffer(await withTimeout(provider.download(ref), 45_000, 'Q4 download'));
          assert(downloaded.length === payload.length, `size mismatch: uploaded ${payload.length} B, downloaded ${downloaded.length} B`);
          assert(downloaded.equals(payload), 'byte-for-byte mismatch after SSH roundtrip — server transformed the payload');
        } finally {
          await provider.delete(ref).catch(() => {});
        }
      }),
    );

    // Q5 — verify must stay quiet without --debug. The per-connection "SSH
    // connecting to host:port" line routes through io.debug() and is silenced
    // unless --debug is on, so verify/push/pull output stays clean.
    tests.push(
      await runTest('Q5', 'bfs verify — connection chatter silent without --debug', async () => {
        const r = runBfs(['verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(!combined.includes('SSH connecting'), `Expected no "SSH connecting" output, got:\n${combined}`);
      }),
    );

    // Q6 — verify with --debug surfaces the connection chatter on stderr.
    tests.push(
      await runTest('Q6', 'bfs verify --debug — connection chatter visible on stderr', async () => {
        const r = runBfs(['--debug', 'verify'], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(r.stderr.includes('SSH connecting'), `Expected "SSH connecting" on stderr with --debug.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        assert(!r.stdout.includes('SSH connecting'), `"SSH connecting" must go to stderr, not stdout.\nstdout: ${r.stdout}`);
      }),
    );

    // Q7 — key auth. Proves the real ssh2 handshake with a private key against a
    // live sshd (the container's PUBLIC_KEY), plus a multi-chunk upload/download
    // roundtrip. The key-body is never a secret — the provider reads it from
    // private_key_path (supplied out of band via BFS_SSH_PRIVATE_KEY).
    if (SSH_KEY_PATH.length === 0) {
      tests.push(skipTest('Q7', 'SSH key-auth — upload/download roundtrip via private key', 'BFS_SSH_PRIVATE_KEY not set (no key-auth path)'));
    } else {
      tests.push(
        await runTest('Q7', 'SSH key-auth — upload/download roundtrip via private key', async () => {
          const size = 256 * 1024;
          const payload = Buffer.alloc(size);
          fillProbePattern(payload);

          const { io } = createMockProviderIO({}, process.cwd(), false);
          const provider = new SshProvider(
            { id: 'smoke-q7', type: 'ssh', adapterPackage: null, config: { host: SSH_HOST, port: SSH_PORT, user: SSH_USER, path: REMOTE_PATHS[0], auth_method: 'key', private_key_path: SSH_KEY_PATH, accept_new_host_key: true } },
            io,
          );
          provider.setVaultName('ssh-key-smoke');

          const fileName = `shard_0.bfs.${Date.now()}`;
          const ref = await withTimeout(provider.upload(fileName, Readable.from(payload), payload.length), 30_000, 'Q7 upload');

          try {
            const downloaded = await streamToBuffer(await withTimeout(provider.download(ref), 30_000, 'Q7 download'));
            assert(downloaded.equals(payload), 'byte-for-byte mismatch after SSH key-auth roundtrip');
          } finally {
            await provider.delete(ref).catch(() => {});
          }
        }),
      );
    }

    // Q8 — offline `provider edit` must REFUSE --accept-new-host-key. Capturing a
    // new host key needs a live connection (TOFU), which an offline edit never
    // makes; accepting it would persist accept_new_host_key=true with a null pin
    // (a standing MITM window). The refusal must land BEFORE any server contact
    // and leave the ssh1 config untouched (still carrying the pin init captured).
    tests.push(
      await runTest('Q8', 'bfs provider edit --accept-new-host-key on ssh → refused offline', async () => {
        const before = await readJson<{ providers: Array<{ id: string; config: Record<string, unknown> }> }>(path.join(vaultDir, '.bfs', 'config.json'));
        const ssh1Before = before.providers.find((p) => p.id === 'ssh1');
        assert(ssh1Before !== undefined, 'ssh1 provider missing before edit');

        const r = runBfs(['provider', 'edit', 'ssh1', '--ci', '--host', SSH_HOST, '--port', String(SSH_PORT), '--user', SSH_USER, '--password', SSH_PASSWORD, '--path', REMOTE_PATHS[0], '--accept-new-host-key'], vaultDir);
        assert(r.status !== 0, `expected non-zero exit (offline refusal), got ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
        const combined = r.stdout + r.stderr;
        assert(combined.includes('--known-host'), `refusal must point the operator at --known-host, got:\n${combined}`);

        const after = await readJson<{ providers: Array<{ id: string; config: Record<string, unknown> }> }>(path.join(vaultDir, '.bfs', 'config.json'));
        const ssh1After = after.providers.find((p) => p.id === 'ssh1');
        assert(JSON.stringify(ssh1After) === JSON.stringify(ssh1Before), 'ssh1 config must be unchanged after a refused edit');
      }),
    );

    // Q9 — the offline-capable alternative the refusal points at: --known-host
    // pins the fingerprint verbatim, without dialing the server. Runs last: it
    // writes a placeholder pin that would fail a real handshake, so no later test
    // may use ssh1 for a live op.
    tests.push(
      await runTest('Q9', 'bfs provider edit --known-host pins offline (no server contact)', async () => {
        const pin = 'SHA256:smokeQ9AAAABBBBCCCCDDDDeeeeFFFFgggghhhh2222';
        const r = runBfs(['provider', 'edit', 'ssh1', '--ci', '--host', SSH_HOST, '--port', String(SSH_PORT), '--user', SSH_USER, '--password', SSH_PASSWORD, '--path', REMOTE_PATHS[0], '--known-host', pin], vaultDir);
        assert(r.status === 0, `exit ${r.status ?? 'null'}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);

        const cfg = await readJson<{ providers: Array<{ id: string; config: Record<string, unknown> }> }>(path.join(vaultDir, '.bfs', 'config.json'));
        const ssh1 = cfg.providers.find((p) => p.id === 'ssh1');
        assert(ssh1?.config.host_key_fingerprint === pin, `expected pin ${pin}, got ${String(ssh1?.config.host_key_fingerprint)}`);
      }),
    );
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }

  return { name: 'Suite Q — SSH/SFTP provider', tests };
}
