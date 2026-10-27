import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readState } from '../../src/vault/state.js';
import { init, prune, pull, push } from '../../src/vault/vault-manager.js';

// Pull overwrites the working directory, so it asks before doing so when that
// directory holds files - and the decision keys on the directory's CONTENTS, not
// on working_version. Version 0 means both "nothing restored" and "a restored
// copy stored as v0", and a directory after recovery (or after pruning the
// version that was on disk) sits at working_version 0 while still full of the
// operator's files. A gate that reads working_version 0 as "empty" overwrites
// those files with no prompt, and a --ci run does it with no refusal.
//
// "Files" means files the operator would lose: everything except the vault's own
// scaffolding (.bfs/ and .bfsignore, which `_unpackFiles --force` also preserves)
// and anything a .bfsignore pattern excludes (pull never restores those, so there
// is nothing to overwrite). .bfsignore is itself written by `init`, so counting
// it would make a directory holding nothing else ask.

const VAULT_NAME = 'pull-consent';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** An io recording every confirm() it is asked, answering each with `answer`. */
function recordingIo(root: string, interactive: boolean, answer: boolean): { io: ProviderIO; confirms: string[] } {
  const confirms: string[] = [];
  const { io } = createMockProviderIO({}, root, interactive);
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

/** An io that takes "New version" whenever push asks, so setup never overwrites. */
function newVersionIo(root: string): ProviderIO {
  const { io } = createMockProviderIO({}, root, true);
  return {
    ...io,
    async choose(_message: string, options: string[]): Promise<string> {
      return options.find((o) => o.startsWith('New version')) ?? options[0] ?? '';
    },
  };
}

describe('pull overwrite consent at working_version 0 with files on disk', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-pull-consent-root-');
    pdirs = [await mkTmp('bfs-pull-consent-p0-'), await mkTmp('bfs-pull-consent-p1-'), await mkTmp('bfs-pull-consent-p2-')];
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: createMockProviderIO({}, root, false).io,
    });
    // Two versions, then prune the newest: latest_version 1, working_version 0 -
    // the same state recovery leaves, with the operator's file still on disk.
    await fs.writeFile(path.join(root, 'a.txt'), 'v1-content', 'utf-8');
    await push(root, { io: newVersionIo(root), mode: PushMode.NewVersion });
    await fs.writeFile(path.join(root, 'a.txt'), 'v2-content', 'utf-8');
    await push(root, { io: newVersionIo(root), mode: PushMode.NewVersion });
    await prune(root, { versions: [2], io: newVersionIo(root) });
    expect(await readState(root)).toMatchObject({ latest_version: 1, working_version: 0 });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should refuse a non-operator pull when the working directory holds files', async () => {
    const { io } = recordingIo(root, false, false);

    const attempt = pull(root, { io });

    await expect(attempt).rejects.toThrow(BfsError);
    // The refusal is the consent gate's own - it speaks of the files and names
    // the flag that gives consent, not of a version on disk.
    await expect(attempt).rejects.toThrow(/files in the working directory.*--yes/);
    // The operator's file is left untouched - the refusal lands before any unpack.
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v2-content');
  });

  it('should ask before overwriting on an interactive pull and abort when declined', async () => {
    const { io, confirms } = recordingIo(root, true, false);

    const attempt = pull(root, { io });

    await expect(attempt).rejects.toThrow(BfsError);
    expect(confirms).toHaveLength(1);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v2-content');
  });

  it('should restore when the interactive operator consents, naming the files not a bogus on-disk version', async () => {
    const { io, confirms } = recordingIo(root, true, true);

    const result = await pull(root, { io });

    expect(result.version).toBe(1);
    expect(confirms).toHaveLength(1);
    // No version is restored in the directory (working_version 0), so the prompt
    // names the files at risk - never "On disk: version 0", which would be false.
    expect(confirms.join('\n')).toContain('working directory');
    expect(confirms.join('\n')).not.toContain('On disk: version');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });

  it('should skip the prompt with --yes even when files are on disk', async () => {
    const { io, confirms } = recordingIo(root, true, false);

    const result = await pull(root, { io, yes: true });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });

  it('should skip the prompt with --force even when files are on disk', async () => {
    const { io, confirms } = recordingIo(root, true, false);

    const result = await pull(root, { io, force: true });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });

  it('should restore without asking when only the vault scaffolding (.bfs/ + .bfsignore) is on disk', async () => {
    // .bfsignore stays - it is the vault's own file, written by init. It is not
    // something the operator would lose, so it must not count as "files on disk".
    await fs.rm(path.join(root, 'a.txt'));
    const { io, confirms } = recordingIo(root, true, false);

    const result = await pull(root, { io });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });

  it('should restore without asking when the only file on disk is excluded by a .bfsignore pattern', async () => {
    // A file a .bfsignore pattern excludes is never restored by pull, so there is
    // nothing to overwrite - the consent check must honour the patterns, not just
    // readdir the directory. A naive readdir-based gate would prompt here.
    await fs.rm(path.join(root, 'a.txt'));
    await fs.writeFile(path.join(root, '.bfsignore'), 'ignored-*\n', 'utf-8');
    await fs.writeFile(path.join(root, 'ignored-secret.txt'), 'local only', 'utf-8');
    const { io, confirms } = recordingIo(root, true, false);

    const result = await pull(root, { io });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
  });
});

describe('pull overwrite consent at working_version > 0 keys on contents too', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await mkTmp('bfs-pull-consent2-root-');
    pdirs = [await mkTmp('bfs-pull-consent2-p0-'), await mkTmp('bfs-pull-consent2-p1-'), await mkTmp('bfs-pull-consent2-p2-')];
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: createMockProviderIO({}, root, false).io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'v1-content', 'utf-8');
    await push(root, { io: newVersionIo(root), mode: PushMode.NewVersion });
    expect(await readState(root)).toMatchObject({ latest_version: 1, working_version: 1 });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should name the version on disk when one is restored and files are present', async () => {
    const { io, confirms } = recordingIo(root, true, false);

    const attempt = pull(root, { io });

    await expect(attempt).rejects.toThrow(BfsError);
    expect(confirms).toHaveLength(1);
    expect(confirms.join('\n')).toContain('On disk: version 1');
    expect(confirms.join('\n')).not.toContain('The working directory has files');
  });

  it('should not ask when a version is on disk but the directory has no files to overwrite', async () => {
    await fs.rm(path.join(root, 'a.txt'));
    const { io, confirms } = recordingIo(root, true, false);

    const result = await pull(root, { io });

    expect(result.version).toBe(1);
    expect(confirms).toEqual([]);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('v1-content');
  });
});
