import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- What is pinned: an offline edit cannot arm a host-key MITM window --------
//
// `bfs provider edit` via flags/`--ci` is offline: the flag path never contacts
// the medium (no probeConnection / healthCheck) and does a FULL replacement of
// the provider's connection-config (configureFromFlags starts from an empty {}).
//
// `--accept-new-host-key` means "connect to the server, capture its host key and
// PIN it (TOFU)". That pin can only be captured by contacting the server - which
// an offline edit never does. Persisting `accept_new_host_key: true` with NO
// `host_key_fingerprint` would leave a later non-interactive `push` trusting ANY
// host key, so an offline flag edit REFUSES the flag (CommandAbort, nothing
// written) and points the operator to `--known-host <SHA256:...>` - the only way
// to establish trust without contacting the medium.
//
// What enforces that is the `input.offline === true` guard in
// SshProvider.configureFromFlags (src/providers/ssh.ts), which provider-edit.ts
// arms unconditionally on the flag path. It runs BEFORE the capture gate
// (`this.io.interactive === false`), so no combination of terminal and flags
// reaches captureHostKey from this command.
//
// CRITICAL (a mock IO is not runtime IO): a test injecting `interactive: false`
// into a mock IO would let the capture gate fire against the ssh2 mock and pin a
// fingerprint, hiding whether the offline guard is doing its job. So this drives
// the REAL command via `runCmd`, with the real `createCliProviderIO` and a
// simulated TTY (`process.stdin.isTTY = true`), and asserts on the CONTENT of
// the persisted provider config.

// A pin the operator already trusts, established out of band (offline path).
const KNOWN_HOST_FP = 'SHA256:knownhostAAAABBBBCCCCDDDDeeeeFFFFgggghhhh0000';
// A stale pin already in the existing config - full replacement must drop it.
const OLD_FP = 'SHA256:oldpinnnAAAABBBBCCCCDDDDeeeeFFFFgggghhhh1111';

// --- ssh2 mock: keep the test hermetic (no real network) ----------------------
// No path here reaches a server - the offline guard refuses before the capture
// gate. The mock only guarantees that if any path DID reach captureHostKey, it
// would resolve a fingerprint locally instead of dialing a real server.
const SERVER_KEY = Buffer.from('mock-ssh-ed25519-host-key');

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

// Redirect ~ so the SSH provider's known_hosts lookup / default-key discovery
// never touches the real dev machine.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const nonExistentHome = `${actual.tmpdir()}/bfs-provider-edit-ssh-no-home-DOES-NOT-EXIST`;
  const homedir = () => nonExistentHome;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

// Capture the persisted config instead of touching a real `.bfs/config.json`.
vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));

// Side-effect import: register the SSH provider so `provider edit` can build it.
// Must come after the ssh2 mock (hoisted) so the provider loads against the mock.
import '../../src/providers/ssh.js';
import { SshProvider } from '../../src/providers/ssh.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// process.stdin.isTTY is typed `boolean` but is `undefined` off a TTY at runtime;
// this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

/** Builds an existing SSH provider entry for the vault config fixture. */
function makeSshProvider(overrides: Record<string, unknown> = {}) {
  return { id: 'nas', type: 'ssh', adapterPackage: null, config: { host: 'oldhost', port: 22, user: 'backup', password: 'oldpw', auth_method: 'password', path: '/backup', ...overrides } };
}

describe('provider edit ssh on a TTY - host-key trust must stay offline-safe', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;
  let probeSpy: ReturnType<typeof vi.spyOn>;
  let healthSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    // Simulate an interactive terminal - the exact condition that surfaces the
    // bug (createCliProviderIO defaults io.interactive to process.stdin.isTTY).
    stdinTty.isTTY = true;

    vi.mocked(writeConfig).mockResolvedValue(undefined);
    // Offline edit must never contact the medium; spy so we can prove it stays
    // offline even on the GREEN paths.
    probeSpy = vi.spyOn(SshProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
    healthSpy = vi.spyOn(SshProvider.prototype, 'healthCheck').mockResolvedValue(true);
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // --- MAIN RED --------------------------------------------------------------

  it('should refuse --accept-new-host-key offline and never persist accept_new_host_key with a null fingerprint', async () => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [makeSshProvider()] }) as never);

    const result = await runCmd(['provider', 'edit', 'nas', '--ci', '--host', 'newhost', '--user', 'u', '--password', 'pw', '--path', '/backup', '--accept-new-host-key']);

    // RED today: on a TTY the capture gate is skipped, so the command persists the
    // MITM combination - accept_new_host_key=true with NO host_key_fingerprint.
    // The fix must instead abort without writing, so this combination never lands.
    const wroteArmedMitm =
      vi.mocked(writeConfig).mock.calls.length > 0 &&
      (() => {
        const persisted = vi.mocked(writeConfig).mock.calls[0][1];
        const nas = persisted.providers.find((p) => p.id === 'nas');
        return nas?.config.accept_new_host_key === true && typeof nas?.config.host_key_fingerprint !== 'string';
      })();
    expect(wroteArmedMitm).toBe(false);

    // The offline edit cannot complete TOFU, so it must refuse and redirect the
    // operator to --known-host.
    expect(result).toBe('abort');
    expect(vi.mocked(writeConfig)).not.toHaveBeenCalled();
    // Refusal is offline - no medium contact even on the reject path.
    expect(probeSpy).not.toHaveBeenCalled();
    expect(healthSpy).not.toHaveBeenCalled();
  });

  // --- GUARD (green today): --known-host pins offline -------------------------

  it('should pin host_key_fingerprint from --known-host without contacting the server', async () => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [makeSshProvider()] }) as never);

    const result = await runCmd(['provider', 'edit', 'nas', '--ci', '--host', 'newhost', '--user', 'u', '--password', 'pw', '--path', '/backup', '--known-host', KNOWN_HOST_FP]);

    expect(result).toBe('ok');
    expect(vi.mocked(writeConfig)).toHaveBeenCalledOnce();
    const persisted = vi.mocked(writeConfig).mock.calls[0][1];
    const nas = persisted.providers.find((p) => p.id === 'nas');
    // The provided pin is written verbatim, and no accept-new opt-in is armed.
    expect(nas?.config.host_key_fingerprint).toBe(KNOWN_HOST_FP);
    expect(nas?.config.accept_new_host_key).toBeUndefined();
    // Offline: --known-host establishes trust without any medium contact.
    expect(probeSpy).not.toHaveBeenCalled();
    expect(healthSpy).not.toHaveBeenCalled();
  });

  // --- GUARD (green today): full replacement resets stale host-key trust ------

  it('should drop the old host_key_fingerprint when the config is replaced without a host-key flag', async () => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [makeSshProvider({ host_key_fingerprint: OLD_FP })] }) as never);

    const result = await runCmd(['provider', 'edit', 'nas', '--ci', '--host', 'newhost', '--user', 'u', '--password', 'pw', '--path', '/backup']);

    expect(result).toBe('ok');
    expect(vi.mocked(writeConfig)).toHaveBeenCalledOnce();
    const persisted = vi.mocked(writeConfig).mock.calls[0][1];
    const nas = persisted.providers.find((p) => p.id === 'nas');
    // Full replacement = trust reset: the stale pin does not survive an edit that
    // carries no host-key flag.
    expect(nas?.config.host_key_fingerprint).toBeUndefined();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(healthSpy).not.toHaveBeenCalled();
  });
});
