import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VaultConfig } from '../../src/types/index.js';
import { captureConsole, makeConfig, runCmd } from './_helpers.js';

// The sibling suite proves the decision (withdraw or keep) against an in-memory
// config. This one proves the effect an operator actually gets: the entry is
// gone from `.bfs/config.json` on disk, and the terminal says so. Only
// removeProvider is mocked - the config layer is the real one, writing real
// bytes to a real vault directory.

vi.mock('../../src/vault/vault-manager.js', () => ({ listVersions: vi.fn(), removeProvider: vi.fn() }));

import { BfsError } from '../../src/core/errors.js';
import { setLang } from '../../src/i18n/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listVersions, removeProvider } from '../../src/vault/vault-manager.js';

describe('provider remove - withdrawn target on disk', () => {
  let rootDir: string;
  let targetDir: string;
  let console_: ReturnType<typeof captureConsole>;

  beforeEach(async () => {
    setLang('en');
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-remove-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-target-'));
    await fs.mkdir(path.join(rootDir, '.bfs'));
    await writeConfig(rootDir, makeConfig() as unknown as VaultConfig);

    vi.mocked(listVersions).mockResolvedValue([]);
    vi.mocked(removeProvider).mockRejectedValue(new BfsError('rebuild failed'));
    console_ = captureConsole();
  });

  afterEach(async () => {
    console_.restore();
    vi.clearAllMocks();
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('should leave no trace of the target in the config file a failed rebuild wrote', async () => {
    const outcome = await runCmd(['--cwd', rootDir, 'provider', 'remove', 'dysk-1', '--strategy', 'rebuild', '--target', 'dysk-4', '--new-type', 'local', '--path', targetDir, '--scope', 'all']);

    expect(outcome).toBe('abort');

    const onDisk = await readConfig(rootDir);
    expect(onDisk?.providers.map((p) => p.id)).toEqual(['dysk-1', 'dysk-2', 'dysk-3']);
    expect(await fs.readFile(path.join(rootDir, '.bfs', 'config.json'), 'utf-8')).not.toContain('dysk-4');
    expect(console_.logs.join('\n')).toContain('has been removed again');
  });
});
