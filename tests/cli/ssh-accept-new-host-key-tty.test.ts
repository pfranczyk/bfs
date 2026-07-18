import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Bug under test (host-key pinning MITM window) ────────────────────────────
//
// `--accept-new-host-key` must, on FIRST contact with a new SSH host, capture and
// PIN the server's key fingerprint into the persisted provider config
// (`host_key_fingerprint`) — OpenSSH `accept-new` semantics — so every later
// connection is verified against the pin (`fp === pin`).
//
// The pinning gate in `configureFromFlags` (src/providers/ssh.ts) fires only when
// `this.io.interactive === false`. But `bfs provider add --ci` (provider-add.ts)
// and `bfs init --ci` (init.ts → parse-provider-spec.ts) build their ProviderIO
// via `createCliProviderIO(rootDir)` WITHOUT the second argument, so `interactive`
// defaults to `process.stdin.isTTY === true`. Run from a real terminal (TTY),
// `io.interactive` is therefore `true`, the pinning gate is skipped, and the
// config is persisted with `accept_new_host_key: true` but a NULL fingerprint.
// A later non-interactive `push`/`pull` (cron, no TTY) then trusts ANY host key —
// a standing MITM + password-capture window.
//
// CRITICAL (testing.md → "Mock IO ≠ runtime IO"): the bug lives in the CLI layer
// DERIVING `io.interactive` from `process.stdin.isTTY`. A test that injects
// `interactive: false` into a mock IO bypasses the faulty path and passes falsely.
// So this drives the REAL command via `runCmd`, with the real `createCliProviderIO`
// and a simulated TTY (`process.stdin.isTTY = true`), and asserts on the CONTENT of
// the persisted provider config — not on any mock-IO internal state.
//
// These assertions are RED today (fingerprint absent) and turn GREEN once the CLI
// passes an explicit non-interactive flag to `createCliProviderIO` in `--ci` mode.

// Fixed host key + its OpenSSH SHA-256 fingerprint (mirrors tests/providers/ssh.test.ts).
const SERVER_KEY = Buffer.from('mock-ssh-ed25519-host-key');

/** Mirrors the fingerprint the SSH provider computes from a raw host key. */
function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const SERVER_FP = sshFingerprint(SERVER_KEY);

// ─── ssh2 mock: connect drives hostVerifier with the fixed host key ───────────
// Minimal by design: the RED path never connects (the pinning gate is skipped),
// and the eventual GREEN path only needs `captureHostKey` to resolve the
// fingerprint via `hostVerifier` — no SFTP session is required for that.
interface MockConnectConfig {
  hostVerifier?: (key: Buffer, cb: (ok: boolean) => void) => void;
}

vi.mock('ssh2', () => {
  class MockClient {
    private readonly handlers: Record<string, (arg?: unknown) => void> = {};

    on(event: string, cb: (arg?: unknown) => void): this {
      this.handlers[event] = cb;
      return this;
    }

    connect(cfg: MockConnectConfig): this {
      void (async () => {
        await Promise.resolve();
        if (typeof cfg.hostVerifier === 'function') {
          cfg.hostVerifier(SERVER_KEY, (ok: boolean) => {
            // captureHostKey settles inside the hostVerifier callback; a rejected
            // key would surface as a connection error.
            if (!ok) this.emit('error', Object.assign(new Error('Host key verification failed'), { level: 'client-authentication' }));
          });
        }
      })();
      return this;
    }

    end(): void {
      // no-op
    }

    private emit(event: string, arg?: unknown): void {
      this.handlers[event]?.(arg);
    }
  }

  return { Client: MockClient, default: { Client: MockClient } };
});

// Redirect ~ so the SSH provider's known_hosts lookup never reads the real dev
// machine and resolves 'unknown' (the fingerprint decision then falls to the
// accept-new opt-in). Preserve every other os member (tmpdir(), etc.).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // Build the path from `actual` only — referencing the top-level `path` import
  // here would hit its temporal dead zone (this factory is hoisted above imports).
  const nonExistentHome = `${actual.tmpdir()}/bfs-ssh-tty-no-home-DOES-NOT-EXIST`;
  const homedir = () => nonExistentHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Capture the persisted config instead of touching a real `.bfs/config.json`.
vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
// Capture the InitOptions (incl. the built provider configs) handed to init().
vi.mock('../../src/vault/vault-manager.js', () => ({ init: vi.fn() }));

// Side-effect import: registers the SSH provider in the global registry. Must come
// after the ssh2 mock (hoisted) so the provider module loads against the mock.
import '../../src/providers/ssh.js';
import { SshProvider } from '../../src/providers/ssh.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { init } from '../../src/vault/vault-manager.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// process.stdin.isTTY is typed `boolean` but is `undefined` off a TTY at runtime;
// this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

describe('provider add --ci --type ssh on a TTY — --accept-new-host-key must pin the fingerprint', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    // Simulate an interactive terminal — the exact condition that surfaces the
    // bug (createCliProviderIO defaults io.interactive to process.stdin.isTTY).
    stdinTty.isTTY = true;

    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    // probeConnection is downstream of the configure-time pin decision; stub it so
    // the test stays hermetic (no SFTP round-trip) and focuses on the persisted
    // config content.
    vi.spyOn(SshProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should persist a non-null host_key_fingerprint when adding an ssh provider with --accept-new-host-key', async () => {
    await runCmd(['provider', 'add', '--ci', '--name', 'nas', '--type', 'ssh', '--host', 'sshhost', '--user', 'sshuser', '--password', 'pw', '--path', '/backup', '--accept-new-host-key']);

    // The command completed and persisted the new provider — so a failing pin
    // assertion below is the bug, not an aborted command.
    expect(vi.mocked(writeConfig)).toHaveBeenCalledOnce();
    const persisted = vi.mocked(writeConfig).mock.calls[0][1];
    const nas = persisted.providers.find((p) => p.id === 'nas');
    expect(nas).toBeDefined();

    // RED today: run from a TTY, createCliProviderIO sets io.interactive=true, the
    // pinning gate in configureFromFlags is skipped, and the fingerprint is never
    // captured — persisted as accept_new_host_key=true with a null pin (MITM window).
    expect(nas?.config.host_key_fingerprint).toBe(SERVER_FP);
  });
});

describe('init --ci with an ssh provider spec on a TTY — --accept-new-host-key must pin the fingerprint', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;
  let root: string;

  beforeEach(async () => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    stdinTty.isTTY = true;

    // A real (small) working directory so the command's scan/compressibility
    // pass runs against actual files; init() itself is mocked (asserted on).
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-ssh-tty-'));
    await fs.writeFile(path.join(root, 'data.txt'), 'hello backup world', 'utf8');

    vi.mocked(init).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('should build the ssh provider config with a non-null host_key_fingerprint when --accept-new-host-key is in the spec', async () => {
    await runCmd([
      'init',
      'securevault',
      '--ci',
      '--data-shards',
      '2',
      '--parity-shards',
      '1',
      '--provider',
      'ssh:nas --host sshhost --user sshuser --password pw --path /backup --accept-new-host-key',
      '--provider',
      'ssh:s1 --host sshhost --user sshuser --password pw --path /backup1',
      '--provider',
      'ssh:s2 --host sshhost --user sshuser --password pw --path /backup2',
      '--cwd',
      root,
    ]);

    // The command reached init() with the parsed providers — so a failing pin
    // assertion below is the bug, not an aborted parse.
    expect(vi.mocked(init)).toHaveBeenCalledOnce();
    const options = vi.mocked(init).mock.calls[0][1];
    const nas = options.providers.find((p) => p.id === 'nas');
    expect(nas).toBeDefined();

    // RED today: the --provider spec is parsed with createCliProviderIO(cwd) (no
    // interactive flag) → io.interactive=true on a TTY → the pinning gate is
    // skipped and host_key_fingerprint never lands in the built config.
    expect(nas?.config.host_key_fingerprint).toBe(SERVER_FP);
  });
});
