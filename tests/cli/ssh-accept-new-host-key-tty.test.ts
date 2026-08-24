import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- What is pinned: --accept-new-host-key really captures the fingerprint ----
//
// `--accept-new-host-key` carries OpenSSH `accept-new` semantics: on FIRST
// contact with a new SSH host, capture the server's key fingerprint and PIN it
// into the persisted provider config (`host_key_fingerprint`), so every later
// connection is verified against the pin (`fp === pin`). Persisting the opt-in
// with a null fingerprint would instead leave every later `push`/`pull` trusting
// ANY host key - a standing MITM + password-capture window.
//
// What these two cases pin is the CLI wiring: `bfs provider add --ci`
// (provider-add.ts) and `bfs init --ci` (init.ts -> parse-provider-spec.ts) hand
// the flags through to the adapter and persist the fingerprint it captures. Both
// commands read the flags ONLY on their `--ci` branch - without it they collect
// every field from prompts instead - so a persisted config carrying the values
// that were typed on the command line is also what proves that branch was taken.
//
// CRITICAL (a mock IO is not runtime IO): the values under test are produced by
// the CLI layer. A test calling the adapter directly with a hand-built config
// would bypass that layer and pass regardless of what the commands do. So this
// drives the REAL commands via `runCmd`, with the real `createCliProviderIO` and
// a simulated TTY (`process.stdin.isTTY = true`) - the setting under which a
// command that fell through to prompts would be visible - and asserts on the
// CONTENT of the persisted config, not on mock state.

// Fixed host key + its OpenSSH SHA-256 fingerprint (mirrors tests/providers/ssh.test.ts).
const SERVER_KEY = Buffer.from('mock-ssh-ed25519-host-key');

/** Mirrors the fingerprint the SSH provider computes from a raw host key. */
function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

const SERVER_FP = sshFingerprint(SERVER_KEY);

// --- ssh2 mock: connect drives hostVerifier with the fixed host key -----------
// Minimal by design: `captureHostKey` only needs `hostVerifier` to hand it the
// server key, from which it resolves the fingerprint - no SFTP session required.
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
  // Build the path from `actual` only - referencing the top-level `path` import
  // here would hit its temporal dead zone (this factory is hoisted above imports).
  const nonExistentHome = `${actual.tmpdir()}/bfs-ssh-tty-no-home-DOES-NOT-EXIST`;
  const homedir = () => nonExistentHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Capture the persisted config instead of touching a real `.bfs/config.json`.
// assertNoExistingVault is a no-op here: these runs are about how a provider spec
// is parsed, and the working directory is a fresh mkdtemp with no backup in it.
vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn(), assertNoExistingVault: vi.fn() }));
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

describe('provider add --ci --type ssh on a TTY - --accept-new-host-key must pin the fingerprint', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;

  beforeEach(() => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    // A simulated terminal is the only setting that discriminates: off a TTY the
    // IO comes out non-interactive whatever the command passes.
    stdinTty.isTTY = true;

    vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    // probeConnection is downstream of the configure-time pin decision; stub it so
    // the test stays hermetic (no SFTP round-trip) and focuses on the persisted
    // config content.
    vi.spyOn(SshProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
    // The add-time collision guard lists the target sub-directory over SFTP; stub
    // it so the test stays hermetic (no SFTP round-trip) and does not hang.
    vi.spyOn(SshProvider.prototype, 'list').mockResolvedValue([]);
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should persist a non-null host_key_fingerprint when adding an ssh provider with --accept-new-host-key', async () => {
    await runCmd(['provider', 'add', '--ci', '--name', 'nas', '--type', 'ssh', '--host', 'sshhost', '--user', 'sshuser', '--password', 'pw', '--path', '/backup', '--accept-new-host-key']);

    // The command completed and persisted the new provider - so a failing pin
    // assertion below is the bug, not an aborted command.
    expect(vi.mocked(writeConfig)).toHaveBeenCalledOnce();
    const persisted = vi.mocked(writeConfig).mock.calls[0][1];
    const nas = persisted.providers.find((p) => p.id === 'nas');
    expect(nas).toBeDefined();

    // Read off the command line, not off a prompt - the flags branch really ran.
    expect(nas?.config.host).toBe('sshhost');

    // The pin, not merely the opt-in: `accept_new_host_key` persisted with a null
    // fingerprint would trust any host key on every later connection.
    expect(nas?.config.host_key_fingerprint).toBe(SERVER_FP);
  });
});

describe('init --ci with an ssh provider spec on a TTY - --accept-new-host-key must pin the fingerprint', () => {
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

    // The command reached init() with the parsed providers - so a failing pin
    // assertion below is the bug, not an aborted parse.
    expect(vi.mocked(init)).toHaveBeenCalledOnce();
    const options = vi.mocked(init).mock.calls[0][1];
    const nas = options.providers.find((p) => p.id === 'nas');
    expect(nas).toBeDefined();

    // Same property through the other entry point: the --provider spec is parsed
    // with an IO the command marks non-interactive, so the gate fires and pins.
    expect(nas?.config.host_key_fingerprint).toBe(SERVER_FP);
  });
});
