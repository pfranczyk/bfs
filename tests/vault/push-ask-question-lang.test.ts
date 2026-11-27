import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../../src/i18n/index.js';
import '../../src/providers/local-fs.js'; // registers the built-in 'local' provider type
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// Under push_mode=ask, a push with a version on disk asks whether to create a new
// version or overwrite the current one. The question speaks the interface
// language, and the operator's pick is honoured in that language too: a menu
// translated without changing how the pick is recognised would turn "Overwrite"
// in Polish into a new version.

const VAULT_NAME = 'push-ask-lang';

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

interface AskedMenu {
  message: string;
  options: string[];
}

/**
 * An io that answers the push menu with the entry at `pick`, records the menu,
 * and consents to the version-switch confirmation.
 */
function pickingIo(root: string, pick: number): { io: ProviderIO; asked: AskedMenu[] } {
  const asked: AskedMenu[] = [];
  const { io } = createMockProviderIO({}, root, true);
  return {
    asked,
    io: {
      ...io,
      async choose(message: string, options: string[]): Promise<string> {
        asked.push({ message, options });
        const picked = options[pick];
        if (picked === undefined) throw new Error(`menu has no entry ${pick}: ${JSON.stringify(options)}`);
        return picked;
      },
      async confirm(): Promise<boolean> {
        return true;
      },
    },
  };
}

describe('push_mode=ask overwrite question', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-ask-lang-root-'));
    pdirs = await Promise.all([0, 1, 2].map((i) => fs.mkdtemp(path.join(os.tmpdir(), `bfs-ask-lang-p${i}-`))));
    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.Ask,
      io: createMockProviderIO({}, root, false).io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io: createMockProviderIO({}, root, false).io, mode: PushMode.NewVersion });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa-updated', 'utf-8');
  });

  afterEach(async () => {
    setLang('en');
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should ask in Polish and keep the version number when Polish "Overwrite" is picked', async () => {
    setLang('pl');
    const { io, asked } = pickingIo(root, 1);

    const result = await push(root, { io });

    expect(asked).toEqual([{ message: 'Utworzyć nową wersję v2 czy nadpisać v1?', options: ['Nowa wersja (v2)', 'Nadpisz (v1)'] }]);
    expect(result.version).toBe(1);
    expect((await readState(root)).latest_version).toBe(1);
  });

  it('should create a new version when Polish "New version" is picked', async () => {
    setLang('pl');
    const { io } = pickingIo(root, 0);

    const result = await push(root, { io });

    expect(result.version).toBe(2);
    expect((await readState(root)).latest_version).toBe(2);
  });

  it('should ask in English and keep the version number when English "Overwrite" is picked', async () => {
    setLang('en');
    const { io, asked } = pickingIo(root, 1);

    const result = await push(root, { io });

    expect(asked).toEqual([{ message: 'Create new version v2 or overwrite v1?', options: ['New version (v2)', 'Overwrite (v1)'] }]);
    expect(result.version).toBe(1);
  });

  it('should create a new version when English "New version" is picked', async () => {
    setLang('en');
    const { io } = pickingIo(root, 0);

    const result = await push(root, { io });

    expect(result.version).toBe(2);
  });

  // With an older version on disk the two numbers in the menu differ: the new
  // version follows the latest one, while "Overwrite" names the version on disk -
  // the one it actually replaces.
  it('should name the version on disk in Polish "Overwrite" when a newer version exists', async () => {
    await push(root, { io: createMockProviderIO({}, root, false).io, mode: PushMode.NewVersion });
    await pull(root, { version: 1, io: createMockProviderIO({}, root, false).io, force: true, yes: true });
    expect(await readState(root)).toMatchObject({ latest_version: 2, working_version: 1 });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa-on-v1', 'utf-8');
    setLang('pl');
    const { io, asked } = pickingIo(root, 1);

    const result = await push(root, { io });

    expect(asked).toEqual([{ message: 'Utworzyć nową wersję v3 czy nadpisać v1?', options: ['Nowa wersja (v3)', 'Nadpisz (v1)'] }]);
    expect(result.version).toBe(1);
    expect((await readState(root)).latest_version).toBe(2);
  });
});
