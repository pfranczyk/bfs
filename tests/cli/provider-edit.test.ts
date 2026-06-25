import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

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

import inquirer from 'inquirer';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { providerRegistry } from '../../src/providers/provider.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { registerSecretProvider, SECRET_TYPE, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);
const mockPrompt = vi.mocked(inquirer.prompt);

/** Writes a JSON config file to a temp dir and returns its absolute path. */
async function writeConfigFile(obj: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-edit-cfg-'));
  const file = path.join(dir, 'cfg.json');
  await fs.writeFile(file, JSON.stringify(obj), 'utf8');
  return file;
}

// `bfs provider edit <id>` — OFFLINE local-only edit of an existing provider's
// connection-config in .bfs/config.json. Same provider type, same id; no medium
// contact (no probeConnection / healthCheck). These tests are written RED before
// the command exists: there is no src/cli/commands/provider-edit.ts and the
// `provider edit` sub-command is not registered, so Commander rejects the tokens
// ('commander') or the config-mutation assertions fail.
describe('provider edit', () => {
  let capture: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    capture = captureConsole();
    mockWriteConfig.mockResolvedValue(undefined);
  });

  afterEach(() => {
    capture.restore();
    mockPrompt.mockReset();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ─── CI happy path ────────────────────────────────────────────────────────

  it('CI: should replace the provider connection-config and write updated config', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // dysk-1..3, scheme 2/1
    const cfg = await writeConfigFile({ path: '/mnt/new-a' });

    await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const edited = writtenConfig.providers.find((p: { id: string }) => p.id === 'dysk-1');
    // New path replaces the old one wholesale (full config replacement).
    expect(edited?.config).toEqual({ path: '/mnt/new-a' });
    // id and type are NOT changed by edit.
    expect(edited?.id).toBe('dysk-1');
    expect(edited?.type).toBe('local');
  });

  it('CI: should not change the scheme', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // scheme 2/1
    const cfg = await writeConfigFile({ path: '/mnt/new-a' });

    await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    expect(writtenConfig.scheme.data_shards).toBe(2);
    expect(writtenConfig.scheme.parity_shards).toBe(1);
  });

  it('CI: should leave the other providers untouched', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/new-a' });

    await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const dysk2 = writtenConfig.providers.find((p: { id: string }) => p.id === 'dysk-2');
    const dysk3 = writtenConfig.providers.find((p: { id: string }) => p.id === 'dysk-3');
    expect(dysk2?.config).toEqual({ path: '/tmp/d2' });
    expect(dysk3?.config).toEqual({ path: '/tmp/d3' });
    expect(writtenConfig.providers).toHaveLength(3);
  });

  // ─── Non-existent id ──────────────────────────────────────────────────────

  it('CI: should abort when the provider id does not exist', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'edit', 'nieistnieje', '--ci', '--config-file', '/whatever.json']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── Missing vault config ─────────────────────────────────────────────────

  it('CI: should abort when vault config is missing', async () => {
    mockReadConfig.mockResolvedValue(null);

    const result = await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', '/whatever.json']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── Failing validateConfig ───────────────────────────────────────────────

  it('CI: should abort when adapter validateConfig returns errors', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    vi.spyOn(LocalFsProvider.prototype, 'validateConfig').mockReturnValue(['path must be absolute']);
    const cfg = await writeConfigFile({ path: '/mnt/new-a' });

    const result = await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  // ─── No-changes ───────────────────────────────────────────────────────────

  it('CI: should not write config when the new config equals the current one', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never); // dysk-1 path /tmp/d1
    const cfg = await writeConfigFile({ path: '/tmp/d1' }); // identical to current

    await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    expect(mockWriteConfig).not.toHaveBeenCalled();
    // A no-changes notice must reach the user (exact i18n key lands in GREEN).
    expect([...capture.logs, ...capture.errors].some((l) => /no.?change|bez zmian|nothing/i.test(l))).toBe(true);
  });

  // ─── No network ───────────────────────────────────────────────────────────

  it('CI: should never contact the medium (no probeConnection, no healthCheck)', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const probeSpy = vi.spyOn(LocalFsProvider.prototype, 'probeConnection').mockResolvedValue(undefined);
    const healthSpy = vi.spyOn(LocalFsProvider.prototype, 'healthCheck').mockResolvedValue({ ok: true } as never);
    const cfg = await writeConfigFile({ path: '/mnt/new-a' });

    const result = await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    // Positive gate so this stays RED until the command exists (a missing
    // command never calls probe/health either — that would be a false green).
    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledOnce();
    expect(probeSpy).not.toHaveBeenCalled();
    expect(healthSpy).not.toHaveBeenCalled();
  });

  // ─── Conditional resync hint ──────────────────────────────────────────────
  // After a PLAINTEXT (non-secret) field changes (e.g. path), the output must
  // hint that the next push will resync shard headers. After ONLY a secret
  // field changes (password), there must be NO resync hint. We assert on a
  // stable, non-brittle fragment ("push"/"resync") rather than the full i18n
  // phrase — the i18n key is created in GREEN.

  it('CI: should hint header resync after a plaintext (path) field changes', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    const cfg = await writeConfigFile({ path: '/mnt/changed' });

    await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', cfg]);

    const out = [...capture.logs, ...capture.errors].join('\n');
    expect(/push|resync/i.test(out)).toBe(true);
  });

  it('CI: should NOT hint header resync when only a secret (password) field changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-edit-secret-'));
    registerSecretProvider();
    try {
      // Vault has one secret-type provider; edit changes ONLY the password,
      // keeping the same path (the only plaintext field).
      const existing = secretProviderConfig('secret-1', dir);
      mockReadConfig.mockResolvedValue(makeConfig({ providers: [existing] }) as never);
      const cfg = await writeConfigFile({ path: dir, password: 'pw-changed' });

      const result = await runCmd(['provider', 'edit', 'secret-1', '--ci', '--config-file', cfg]);

      // Positive gate so a missing command (which prints no hint either) does
      // not produce a false green.
      expect(result).toBe('ok');
      expect(mockWriteConfig).toHaveBeenCalledOnce();
      const out = [...capture.logs, ...capture.errors].join('\n');
      expect(/resync/i.test(out)).toBe(false);
      expect(/\bpush\b/i.test(out)).toBe(false);
    } finally {
      unregisterSecretProvider();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ─── Branch gaps: error / cancel paths ────────────────────────────────────

  it('CI: should abort when no id is given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);

    const result = await runCmd(['provider', 'edit', '--ci']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('CI: should abort when adapter configureFromFlags throws', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    vi.spyOn(LocalFsProvider.prototype, 'configureFromFlags').mockRejectedValue(new Error('bad config file'));

    const result = await runCmd(['provider', 'edit', 'dysk-1', '--ci', '--config-file', '/bad.json']);

    expect(result).toBe('abort');
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });

  it('interactive: should cancel without writing when the picker is dismissed', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    mockPrompt.mockResolvedValue({ chosen: '__cancel__' } as never);

    const result = await runCmd(['provider', 'edit']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).not.toHaveBeenCalled();
    expect([...capture.logs, ...capture.errors].some((l) => /cancel|anulow/i.test(l))).toBe(true);
  });

  // ─── Interactive: provider picker when no id given ────────────────────────

  it('interactive: should edit the provider chosen from the picker when no id is given', async () => {
    mockReadConfig.mockResolvedValue(makeConfig() as never);
    // Picker returns dysk-2; the adapter then re-supplies a new path.
    mockPrompt.mockResolvedValue({ chosen: 'dysk-2' } as never);
    vi.spyOn(LocalFsProvider.prototype, 'configureInteractive').mockResolvedValue({ path: '/mnt/picked' });

    const result = await runCmd(['provider', 'edit']);

    expect(result).toBe('ok');
    expect(mockWriteConfig).toHaveBeenCalledOnce();
    const [, writtenConfig] = mockWriteConfig.mock.calls[0];
    const edited = writtenConfig.providers.find((p: { id: string }) => p.id === 'dysk-2');
    expect(edited?.config).toEqual({ path: '/mnt/picked' });
  });

  // ─── Interactive: secret masking ──────────────────────────────────────────

  it('interactive: should not print the current password in plaintext', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-edit-mask-'));
    registerSecretProvider();
    try {
      const existing = secretProviderConfig('secret-1', dir); // password pw-secret-1
      mockReadConfig.mockResolvedValue(makeConfig({ providers: [existing] }) as never);
      // Interactive re-supply: keep path, supply a new password.
      vi.spyOn(LocalFsProvider.prototype, 'configureInteractive').mockResolvedValue({ path: dir, password: 'pw-new' });
      mockPrompt.mockResolvedValue({} as never);

      const result = await runCmd(['provider', 'edit', 'secret-1']);

      // Positive gate: the interactive edit must actually run (display current
      // config + re-supply) — a missing command prints nothing, which would be
      // a false green for the masking assertion.
      expect(result).toBe('ok');
      const out = [...capture.logs, ...capture.errors].join('\n');
      // The existing secret must never be echoed back to the operator verbatim.
      expect(out.includes('pw-secret-1')).toBe(false);
    } finally {
      unregisterSecretProvider();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

// Guard against accidental green: SECRET_TYPE / providerRegistry imports must
// resolve so the file compiles even before the command exists.
void SECRET_TYPE;
void providerRegistry;
