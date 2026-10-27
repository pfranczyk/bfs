import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// The overwrite-consent check walks the working directory before the restore.
// A working directory is often a mount point or a drive root, which carries a
// directory the operator cannot read (`lost+found` on ext4, `System Volume
// Information` on Windows). Such a directory holds nothing pull would restore,
// so it must not stop the restore - the restore itself never needs to read it.
// A working directory the operator cannot read at all still stops the pull.
// Permissions cannot be withdrawn portably from a test, so the refusal is
// injected into readdir for one named directory.

const { blockedNames } = vi.hoisted(() => ({ blockedNames: new Set<string>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = ((...args: Parameters<typeof real.readdir>) => {
    const target = String(args[0]).replace(/\\/g, '/');
    const name = target.slice(target.lastIndexOf('/') + 1);
    if (blockedNames.has(name)) {
      return Promise.reject(Object.assign(new Error(`EACCES: permission denied, scandir '${target}'`), { code: 'EACCES' }));
    }
    return real.readdir(...args);
  }) as typeof real.readdir;
  return { ...real, readdir, default: { ...real, readdir } };
});

const VAULT_NAME = 'pull-consent-unreadable';

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** An io recording every confirm() it is asked, answering each with `answer`. */
function recordingIo(root: string, answer: boolean): { io: ProviderIO; confirms: string[] } {
  const confirms: string[] = [];
  const { io } = createMockProviderIO({}, root, true);
  return {
    confirms,
    io: {
      ...io,
      async confirm(message: string): Promise<boolean> {
        confirms.push(message);
        return answer;
      },
    },
  };
}

describe('pull overwrite consent next to a directory nobody can read', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-pull-unreadable-root-'));
    pdirs = await Promise.all([0, 1, 2].map((i) => fs.mkdtemp(path.join(os.tmpdir(), `bfs-pull-unreadable-p${i}-`))));
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: createMockProviderIO({}, root, false).io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'v1-content', 'utf-8');
    await push(root, { io: createMockProviderIO({}, root, false).io, mode: PushMode.NewVersion });
    // Created after the push, so the backup knows nothing of it - like lost+found.
    await fs.mkdir(path.join(root, 'locked'));
    blockedNames.add('locked');
  });

  afterEach(async () => {
    blockedNames.clear();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should restore without asking when the only other entry is an unreadable directory', async () => {
    await fs.rm(path.join(root, 'a.txt'));
    const { io, confirms } = recordingIo(root, false);

    const result = await pull(root, { io });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });

  it('should still ask when operator files sit next to the unreadable directory', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'local edit', 'utf-8');
    const { io, confirms } = recordingIo(root, false);

    const attempt = pull(root, { io });

    await expect(attempt).rejects.toThrow(/cancelled/i);
    expect(confirms).toHaveLength(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('local edit');
  });

  it('should stop the pull when the working directory itself cannot be read', async () => {
    blockedNames.add(path.basename(root));
    const { io, confirms } = recordingIo(root, true);

    const attempt = pull(root, { io });

    await expect(attempt).rejects.toThrow(/EACCES/);
    expect(confirms).toEqual([]);
  });
});
