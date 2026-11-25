import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- What is pinned: an offline edit cannot leave a bare FTPS opt-in behind ---
//
// `bfs provider edit --ci` is offline: the flag path never contacts the medium
// and replaces the provider's connection config in full. `--accept-new-cert`
// means "read the certificate the server presents and pin it", which needs a
// connection the offline edit never makes. Persisting `accept_new_cert: true`
// with no `cert_fingerprint` would be consent stored on disk and spent again on
// every later run, so the edit refuses the flag (CommandAbort, nothing written).
// The refusal names the conflict and suggests no fix.
//
// This drives the REAL command via `runCmd`, with the real
// `createCliProviderIO` on a simulated TTY, and asserts on what gets persisted -
// a direct configureFromFlags call would hide whether the command arms the
// offline guard at all.

// --- basic-ftp mock: keep the test hermetic (no real network) -----------------
// No path here should reach a server. If one did, the connection fails at once
// instead of dialing out.
vi.mock('basic-ftp', () => {
  class MockClient {
    readonly ftp = { socket: {} };

    async connect(): Promise<never> {
      throw new Error('basic-ftp mock: no server in this test');
    }

    async access(): Promise<never> {
      throw new Error('basic-ftp mock: no server in this test');
    }

    close(): void {
      // no-op
    }
  }
  return { Client: MockClient, default: { Client: MockClient } };
});

// Capture the persisted config instead of touching a real `.bfs/config.json`.
vi.mock('../../src/vault/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/vault/config.js')>();
  return { ...actual, readConfig: vi.fn(), writeConfig: vi.fn() };
});

// Side-effect import: register the FTP provider so `provider edit` can build it.
import '../../src/providers/ftp.js';
import { FtpProvider } from '../../src/providers/ftp.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// process.stdin.isTTY is typed `boolean` but is `undefined` off a TTY at runtime;
// this accessor saves/restores the real value without `any`.
const stdinTty = process.stdin as { isTTY?: boolean | undefined };

/** Builds an existing FTPS provider entry for the vault config fixture. */
function makeFtpsProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'nas',
    type: 'ftp',
    adapterPackage: null,
    config: { host: 'oldhost', port: 21, user: 'backup', password: 'oldpw', path: '/backup', secure: true, cert_fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99', ...overrides },
  };
}

const EDIT_ARGS = ['provider', 'edit', 'nas', '--ci', '--host', 'newhost', '--user', 'u', '--password', 'pw', '--path', '/backup', '--accept-new-cert'];

describe('provider edit ftp --ci - --accept-new-cert must not persist a bare opt-in', () => {
  let capture: ReturnType<typeof captureConsole>;
  let prevTTY: boolean | undefined;
  let probeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = captureConsole();
    prevTTY = stdinTty.isTTY;
    stdinTty.isTTY = true;
    vi.mocked(writeConfig).mockResolvedValue(undefined);
    probeSpy = vi.spyOn(FtpProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    stdinTty.isTTY = prevTTY;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should refuse --accept-new-cert offline and never persist accept_new_cert without a fingerprint', async () => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [makeFtpsProvider()] }) as never);

    const result = await runCmd(EDIT_ARGS);

    expect(result).toBe('abort');
    expect(vi.mocked(writeConfig)).not.toHaveBeenCalled();
    expect(probeSpy).not.toHaveBeenCalled();
  });

  it('should name the conflict in the refusal without suggesting a fix', async () => {
    vi.mocked(readConfig).mockResolvedValue(makeConfig({ providers: [makeFtpsProvider()] }) as never);

    await runCmd(EDIT_ARGS);

    const refusal = capture.errors.join('\n');
    expect(refusal).toContain('--accept-new-cert');
    expect(refusal).toContain('bfs provider edit --ci');
    expect(refusal).not.toContain('--cert-fingerprint');
    expect(refusal).not.toContain('provider add');
  });
});
