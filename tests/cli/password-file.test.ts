import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullResult, PushResult } from '../../src/types/index.js';
import { VersionHealth } from '../../src/types/index.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// --- Contract under test ----------------------------------------------------
//
// A vault password passed as `--password <pw>` sits in the process argv, and on
// Linux /proc/<pid>/cmdline is world-readable - every local account sees the
// secret for as long as the command runs, and monitoring agents that snapshot
// the process table capture it. The shell expands "$VAULT_PASS" BEFORE exec, so
// reading it from a variable does not help: the literal still lands in argv.
//
// `repair` already avoids this with `--password-file <path>` and exports the
// helper that reads it, while the other commands taking that same secret do not
// - including the ones a schedule runs unattended. The defect is that asymmetry,
// not a missing feature: the most valuable secret in the system is protected on
// one path and exposed on the rest.
//
// An explicit --password still wins, so existing invocations keep working.

vi.mock('../../src/vault/vault-manager.js', () => ({ push: vi.fn(), pull: vi.fn(), removeProvider: vi.fn(), listVersions: vi.fn() }));
vi.mock('../../src/vault/recovery.js', () => ({ recover: vi.fn() }));
// provider remove reads the vault config before it does anything else; without
// this it aborts long before the password would matter.
vi.mock('../../src/vault/config.js', () => ({ readConfig: vi.fn(), writeConfig: vi.fn() }));
vi.mock('inquirer', () => ({
  default: {
    prompt: vi.fn(),
    Separator: class {
      type = 'separator';
    },
  },
  Separator: class {
    type = 'separator';
  },
}));
vi.mock('ora', () => ({ default: () => ({ start: vi.fn().mockReturnThis(), stop: vi.fn().mockReturnThis(), succeed: vi.fn().mockReturnThis(), fail: vi.fn().mockReturnThis(), text: '' }) }));

import { providerRegistry } from '../../src/providers/provider.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { recover } from '../../src/vault/recovery.js';
import { listVersions, pull, push, removeProvider } from '../../src/vault/vault-manager.js';

const mockPush = vi.mocked(push);
const mockPull = vi.mocked(pull);
const mockRemoveProvider = vi.mocked(removeProvider);
const mockRecover = vi.mocked(recover);

const SECRET = 'secret-from-file';

let dir: string;
let passwordFile: string;

/** A bootstrap provider that connects without touching the disk or prompting. */
function stubProvider(): void {
  vi.spyOn(providerRegistry, 'create').mockReturnValue({
    authenticate: vi.fn(),
    setVaultName: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    listVaults: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    configureInteractive: vi.fn().mockResolvedValue({}),
    configureFromFlags: vi.fn().mockReturnValue({}),
    validateConfig: vi.fn().mockReturnValue([]),
    describeConfig: vi.fn().mockReturnValue(''),
    getSecretFields: vi.fn().mockReturnValue([]),
    probeConnection: vi.fn(),
  } as unknown as ReturnType<typeof providerRegistry.create>);
}

beforeEach(async () => {
  // restoreAllMocks below puts spies back, but leaves the call history of the
  // module mocks - so a "was never called" assertion would see the previous
  // test's invocation.
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-pwfile-'));
  passwordFile = path.join(dir, 'vault.pass');
  // A trailing newline is what an editor or `echo` leaves behind; it must not
  // become part of the password.
  await fs.writeFile(passwordFile, `${SECRET}\n`, { mode: 0o600 });

  mockPush.mockResolvedValue({ version: 1, file_count: 1, total_size: 1, skipped: [], excluded: [], uploaded_count: 3, failed: [], health: VersionHealth.Healthy } as PushResult);
  mockPull.mockResolvedValue({ version: 1, file_count: 1, restored: 1, skipped: [] } as unknown as PullResult);
  mockRemoveProvider.mockResolvedValue(undefined);
  vi.mocked(readConfig).mockResolvedValue(makeConfig() as never);
  vi.mocked(writeConfig).mockResolvedValue(undefined);
  vi.mocked(listVersions).mockResolvedValue([]);
  mockRecover.mockResolvedValue({ vault_name: 'v', manifests_rebuilt: 1, versions: [] } as unknown as Awaited<ReturnType<typeof recover>>);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('--password-file keeps the vault password out of argv', () => {
  it('should read the password from a file for push', async () => {
    await runCmd(['push', '--password-file', passwordFile]);

    expect(mockPush).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ password: SECRET }));
  });

  it('should read the password from a file for pull', async () => {
    await runCmd(['pull', '--yes', '--password-file', passwordFile]);

    expect(mockPull).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ password: SECRET }));
  });

  it('should read the password from a file for recovery', async () => {
    stubProvider();

    await runCmd(['recovery', '--provider', 'local', '--name', 'v', '--bootstrap', `--path ${dir}`, '--password-file', passwordFile]);

    expect(mockRecover.mock.calls[0]?.[1]?.passwords ?? []).toContain(SECRET);
  });

  it('should read the password from a file for provider remove', async () => {
    // The password is forwarded for every strategy, so this pins the wiring; the
    // strategy that actually consumes it is `rebuild`, which reconstructs a shard
    // from parity. `--strategy` at all is the unattended shape of this command.
    await runCmd(['provider', 'remove', 'dysk-1', '--strategy', 'remove', '--yes', '--password-file', passwordFile]);

    expect(mockRemoveProvider).toHaveBeenCalledWith(expect.any(String), 'dysk-1', expect.objectContaining({ password: SECRET }));
  });

  it('should let an explicit --password win over --password-file for push', async () => {
    await runCmd(['push', '--password', 'from-argv', '--password-file', passwordFile]);

    // Precedence matters for scripts passing both while migrating: the value the
    // operator typed explicitly is the one they meant.
    expect(mockPush).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ password: 'from-argv' }));
  });

  it('should collect both sources into the recovery password pool', async () => {
    stubProvider();

    await runCmd(['recovery', '--provider', 'local', '--name', 'v', '--bootstrap', `--path ${dir}`, '--password', 'from-argv', '--password-file', passwordFile]);

    // recovery tries a POOL - different versions may carry different passwords,
    // so a file must add to the pool, not replace what argv supplied. Dropping
    // either one silently loses access to some versions.
    const passwords = mockRecover.mock.calls[0]?.[1]?.passwords ?? [];
    expect(passwords).toContain('from-argv');
    expect(passwords).toContain(SECRET);
  });

  it('should refuse with an actionable message when the file is missing', async () => {
    const missing = path.join(dir, 'nope.pass');
    const cap = captureConsole();
    const result = await runCmd(['push', '--password-file', missing]);
    cap.restore();
    const output = [...cap.logs, ...cap.errors].join('\n');

    // Falling through to "no password" would surface later as a decryption
    // failure on a medium, pointing at the wrong thing entirely. The message has
    // to name the path, and must not be a raw ENOENT dump from Node.
    expect(result).toBe('abort');
    expect(mockPush).not.toHaveBeenCalled();
    expect(output).toContain(missing);
    expect(output).not.toContain('ENOENT');
  });

  it('should refuse when the password file is empty', async () => {
    const empty = path.join(dir, 'empty.pass');
    await fs.writeFile(empty, '\n', { mode: 0o600 });
    const cap = captureConsole();
    const result = await runCmd(['push', '--password-file', empty]);
    cap.restore();
    const output = [...cap.logs, ...cap.errors].join('\n');

    // An empty file reads as an empty password, which is falsy - so without a
    // guard it degrades into the interactive prompt, i.e. a hang or a crash on
    // the closed stdin of a scheduled run. Exactly the mistake the missing-file
    // case guards against, one step further in.
    expect(result).toBe('abort');
    expect(mockPush).not.toHaveBeenCalled();
    expect(output).toContain(empty);
  });
});
