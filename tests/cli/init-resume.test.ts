// `bfs init` resumable from the command line, interactively and under --ci.
//
// The interactive path collects and probes every storage in the CLI before it
// reaches the vault layer, so it is there that each storage has to be recorded as
// it passes - otherwise the operator who aborts at the third storage loses the
// first two. A second `bfs init` in that directory resumes: it asks only for the
// storages still missing, with the backup name, scheme, encryption, compression,
// push mode and memory limit taken from the file. Under --ci the command line
// names the whole pool; storages already recorded under the same name are taken
// as verified, the rest are probed and appended, and a command line that does not
// match what is recorded - backup name, a setting, or a pool leaving out a
// recorded storage - is refused, naming the difference.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/core/errors.js';
import { findStringFlag } from '../../src/providers/flags.js';
import * as providerMod from '../../src/providers/provider.js';
import { providerRegistry } from '../../src/providers/provider.js';
import type { CliProviderInput, ProviderConfig, ProviderIO, StorageProvider, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { captureConsole, runCmd } from './_helpers.js';

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

const mockPrompt = vi.mocked(inquirer.prompt);

const FAKE_TYPE = 'fakeresume';

/** Ids whose probe fails (a storage that does not answer). */
let failingIds: Set<string>;
/** probeConnection() calls per provider id. */
let probeCalls: Map<string, number>;
/** Runs at the start of every probe - lets a test look at the disk mid-init. */
let onProbe: Nullable<(id: string) => Promise<void>>;
/** Ids whose medium already holds a part of another backup of the same name. */
let foreignIds: Set<string>;

/** Registers a storage type whose probe passes unless its id is in `failingIds`. */
function registerFakeType(): void {
  providerRegistry.register(FAKE_TYPE, {
    lang: 'en',
    displayName: 'Fake Resume',
    create: (config: ProviderConfig) => {
      let vaultName = '';
      return {
        id: config.id,
        type: FAKE_TYPE,
        async authenticate(): Promise<void> {},
        setVaultName(name: string): void {
          vaultName = name;
        },
        async probeConnection(): Promise<void> {
          probeCalls.set(config.id, (probeCalls.get(config.id) ?? 0) + 1);
          if (onProbe !== null) await onProbe(config.id);
          if (vaultName === '') throw new Error('setVaultName() must precede probeConnection()');
          if (failingIds.has(config.id)) throw new ProviderError(`storage ${config.id} does not answer`);
        },
        async list() {
          // A storage in `foreignIds` already holds a part of another backup of the same name.
          return foreignIds.has(config.id) ? [{ provider_id: config.id, path: 'shard_0.bfs.1' }] : [];
        },
        async downloadHeader(): Promise<Buffer> {
          throw new Error('header not readable in this fixture');
        },
        async configureInteractive(): Promise<Record<string, unknown>> {
          return { path: `/m/${config.id}` };
        },
        async configureFromFlags(input: CliProviderInput): Promise<Record<string, unknown>> {
          return { path: findStringFlag(input.rawArgs, '--path') ?? '' };
        },
        validateConfig: () => [],
        getSecretFields: () => [],
        usesSidecar: () => false,
        uploadHeaderSidecar: async () => {},
        downloadHeaderSidecar: async () => null,
        verifyShard: async () => ({ ok: true }),
      } as unknown as StorageProvider;
    },
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

/**
 * Answers inquirer prompts by question name, records every name asked, and hands
 * out storage ids in order. An id the question's own `validate` rejects is
 * recorded in `rejected` and the next one is offered, as inquirer would re-ask.
 * `chooseIndex` picks the recovery action when a probe fails (0 retry,
 * 1 re-enter, 2 abort).
 */
function scriptPrompts(ids: string[], chooseIndex = 2, overrides: Record<string, unknown> = {}): { asked: string[]; rejected: string[] } {
  const asked: string[] = [];
  const rejected: string[] = [];
  const queue = [...ids];
  const answers: Record<string, unknown> = { name: 'docs', encEnabled: false, compressEnabled: false, dataShardsStr: '2', parityShardsStr: '1', type: FAKE_TYPE, pushMode: PushMode.NewVersion, maxRamStr: '1024', ...overrides };
  mockPrompt.mockImplementation((async (questions: Array<{ name: string; validate?: (v: string) => unknown }>) => {
    const out: Record<string, unknown> = {};
    for (const q of questions) {
      asked.push(q.name);
      if (q.name !== 'id') {
        out[q.name] = answers[q.name];
        continue;
      }
      let id = queue.shift();
      while (id !== undefined && q.validate !== undefined && (await q.validate(id)) !== true) {
        rejected.push(id);
        id = queue.shift();
      }
      out[q.name] = id;
    }
    return out;
  }) as never);
  const real = providerMod.createCliProviderIO;
  vi.spyOn(providerMod, 'createCliProviderIO').mockImplementation((workDir: string, interactive?: boolean) => {
    const io: ProviderIO = real(workDir, interactive);
    return { ...io, choose: async (_m: string, options: string[]) => options[chooseIndex] ?? options[0] ?? '', warn: () => {} };
  });
  return { asked, rejected };
}

/** The configuration an interrupted init leaves: one storage of a 2/1 scheme. */
function unfinishedConfig(): VaultConfig {
  return {
    vault_id: '550e8400-e29b-41d4-a716-446655440000',
    vault_name: 'docs',
    version: 1,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers: [{ id: 'p1', type: FAKE_TYPE, adapterPackage: null, config: { path: '/m/p1' } }],
    max_ram_mb: null,
  };
}

/** `--provider` spec for storage `id` at its fixture path. */
function spec(id: string): string {
  return `${FAKE_TYPE}:${id} --path /m/${id}`;
}

describe('bfs init - resumable from the command line', () => {
  let capture: ReturnType<typeof captureConsole>;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-init-resume-cli-'));
    capture = captureConsole();
    failingIds = new Set();
    probeCalls = new Map();
    onProbe = null;
    foreignIds = new Set();
    registerFakeType();
  });

  afterEach(async () => {
    capture.restore();
    mockPrompt.mockReset();
    vi.restoreAllMocks();
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(FAKE_TYPE);
    await fs.rm(root, { recursive: true, force: true });
  });

  // The settings the operator chose go into the first write as chosen: a resume
  // takes them from the file, so a default written in their place - encryption
  // off where it was asked for - would change the backup silently.
  it('should keep the storages set up before the operator aborted an interactive init, with the chosen settings', async () => {
    failingIds = new Set(['p2']);
    scriptPrompts(['p1', 'p2'], 2, { encEnabled: true, compressEnabled: true }); // abort at the second storage

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('abort');
    const config = await readConfig(root);
    expect(config?.vault_name).toBe('docs');
    expect(config?.providers.map((p) => p.id)).toEqual(['p1']);
    expect(config?.encryption.enabled).toBe(true);
    expect(config?.compression.enabled).toBe(true);
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
  });

  // The write happens when a storage passes, not on the way out of a failure: a
  // closed terminal runs no handler. The disk is read while the next storage is
  // probed, in a run that does not fail.
  it('should have each storage on disk before the next one is probed', async () => {
    const seen = new Map<string, string[]>();
    onProbe = async (id) => {
      seen.set(id, (await readConfig(root))?.providers.map((p) => p.id) ?? []);
    };
    scriptPrompts(['p1', 'p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('ok');
    expect(seen.get('p2')).toEqual(['p1']);
    expect(seen.get('p3')).toEqual(['p1', 'p2']);
  });

  // Recording a storage as it passes must not skip the guard against another
  // backup of the same name already on it - on the interactive path too, and for
  // a storage after the first.
  it('should not record a storage that holds another backup of the same name', async () => {
    foreignIds = new Set(['p2']);
    scriptPrompts(['p1', 'p2', 'p3']);

    await runCmd(['--cwd', root, 'init']);

    const ids = (await readConfig(root))?.providers.map((p) => p.id) ?? [];
    expect(ids).toEqual(['p1']);
  });

  // A name typed twice in one run is refused at the prompt: with every storage
  // recorded as it passes, a later check would come after the duplicate is on disk.
  it('should refuse a storage name already used earlier in the same interactive run', async () => {
    const { rejected } = scriptPrompts(['p1', 'p1', 'p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('ok');
    expect(rejected).toEqual(['p1']);
    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  // Every storage that passes is recorded, not only the first.
  it('should keep every storage that passed before the abort', async () => {
    failingIds = new Set(['p3']);
    scriptPrompts(['p1', 'p2', 'p3'], 2);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('abort');
    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  // Versions on disk without the settings: the refusal names that state, with no
  // command (BFS cannot tell whether that backup is wanted back). It comes before
  // any storage question: the probe of each storage creates the backup's
  // sub-directory on it.
  it('should refuse .bfs/ with manifest files and no configuration before asking about any storage', async () => {
    await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
    await fs.writeFile(path.join(root, '.bfs', 'manifests', 'v001.json'), '{}', 'utf-8');
    const { asked } = scriptPrompts(['p1', 'p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toMatch(/version/i);
    expect(capture.errors.join('\n')).not.toMatch(/`bfs [a-z]/);
    expect(asked).not.toContain('id');
    expect(probeCalls.size).toBe(0);
  });

  it('should resume interactively, asking only for the missing storages', async () => {
    await writeConfig(root, unfinishedConfig());
    const { asked } = scriptPrompts(['p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('ok');
    for (const settled of ['name', 'encEnabled', 'compressEnabled', 'dataShardsStr']) {
      expect(asked, `the recorded "${settled}" must not be asked again`).not.toContain(settled);
    }
    expect(asked.filter((n) => n === 'id')).toHaveLength(2);
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(config?.vault_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(config?.encryption.enabled).toBe(false);
    expect(config?.compression.enabled).toBe(false);
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
    expect(probeCalls.get('p1')).toBeUndefined();
    // The operator is told this is a resume and how many storages are missing -
    // the state, with no command.
    const lines = [...capture.logs, ...capture.errors];
    const resumeLine = lines.find((l) => /resum/i.test(l));
    expect(resumeLine, `no resume line in:\n${lines.join('\n')}`).toBeDefined();
    expect(resumeLine).toMatch(/\b2\b/);
    expect(lines.join('\n')).not.toContain('bfs provider add');
    expect(lines.join('\n')).not.toContain('bfs scheme set');
  });

  // An interactive resume asked for another backup name, or given an explicit
  // encryption/compression flag that contradicts the file, is refused before any
  // question - finishing the recorded backup instead would be the silent change
  // the resume must not make.
  it('should refuse an interactive resume under another backup name before asking anything', async () => {
    await writeConfig(root, unfinishedConfig());
    const before = await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8');
    const { asked } = scriptPrompts(['p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init', 'photos']);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('docs');
    expect(capture.errors.join('\n')).toContain('photos');
    expect(asked).toEqual([]);
    expect(await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8')).toBe(before);
  });

  it('should refuse an interactive resume whose explicit --enc contradicts the recorded setting', async () => {
    await writeConfig(root, unfinishedConfig()); // recorded: not encrypted
    const { asked } = scriptPrompts(['p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init', '--enc']);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toMatch(/encrypt/i);
    expect(asked).toEqual([]);
    expect(probeCalls.size).toBe(0);
  });

  it('should refuse an interactive resume whose explicit --compress contradicts the recorded setting', async () => {
    await writeConfig(root, unfinishedConfig()); // recorded: not compressed
    const { asked } = scriptPrompts(['p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init', '--compress']);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toMatch(/compress/i);
    expect(asked).toEqual([]);
  });

  // push_mode and max_ram are asked before the storages, so the first write
  // carries what the operator chose - a resume takes them from the file and
  // does not ask again.
  it('should ask push mode and memory before the storages and record them in the first write', async () => {
    failingIds = new Set(['p2']);
    const { asked } = scriptPrompts(['p1', 'p2'], 2, { pushMode: PushMode.Overwrite, maxRamStr: '512' });

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('abort');
    expect(asked.indexOf('pushMode')).toBeGreaterThan(-1);
    expect(asked.indexOf('pushMode')).toBeLessThan(asked.indexOf('id'));
    expect(asked.indexOf('maxRamStr')).toBeLessThan(asked.indexOf('id'));
    const config = await readConfig(root);
    expect(config?.push_mode).toBe(PushMode.Overwrite);
    expect(config?.max_ram_mb).toBe(512);
  });

  it('should not ask push mode or memory again when resuming', async () => {
    await writeConfig(root, unfinishedConfig());
    const { asked } = scriptPrompts(['p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('ok');
    expect(asked).not.toContain('pushMode');
    expect(asked).not.toContain('maxRamStr');
  });

  // A name already recorded is not a missing storage: taking it again would put
  // two entries under one name, and lookups by name reach only the first.
  it('should refuse a recorded storage name for a missing storage when resuming interactively', async () => {
    await writeConfig(root, unfinishedConfig());
    const { rejected } = scriptPrompts(['p1', 'p2', 'p3']);

    const result = await runCmd(['--cwd', root, 'init']);

    expect(result).toBe('ok');
    expect(rejected).toEqual(['p1']);
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(config?.providers[0]?.config).toEqual({ path: '/m/p1' });
  });

  it('should resume under --ci, probing only the storages not yet recorded', async () => {
    await writeConfig(root, unfinishedConfig());

    const result = await runCmd(['--cwd', root, 'init', 'docs', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', '--provider', spec('p1'), '--provider', spec('p2'), '--provider', spec('p3')]);

    expect(result).toBe('ok');
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(config?.vault_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(probeCalls.get('p1')).toBeUndefined();
    expect(probeCalls.get('p3')).toBe(1);
  });

  it('should refuse a --ci resume under another backup name and leave the file as it was', async () => {
    await writeConfig(root, unfinishedConfig());

    const result = await runCmd(['--cwd', root, 'init', 'photos', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', '--provider', spec('p1'), '--provider', spec('p2'), '--provider', spec('p3')]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toContain('docs');
    expect(capture.errors.join('\n')).toContain('photos');
    const config = await readConfig(root);
    expect(config?.vault_name).toBe('docs');
    expect(config?.providers.map((p) => p.id)).toEqual(['p1']);
  });

  // A setting on the command line that differs from the recorded one is refused,
  // naming the setting: ignoring it leaves a configuration other than the one
  // asked for. The worst case is the first - the file says "not encrypted" and the
  // command (no --no-enc) asks for encryption.
  // These cases run through runCmd, which does not put the tokens into
  // process.argv - so an explicit --compress / --no-compress has to be read from
  // the parsed options, not from process.argv, for them to see it.
  // `others` are the settings that match in that case, so the refusal must not
  // name them. Encryption cannot be among them: with --no-enc the run also warns
  // that the backup is not encrypted, on the same channel.
  const SETTING_MISMATCHES: Array<{ setting: string; pattern: RegExp; flags: string[]; others: RegExp[] }> = [
    { setting: 'encryption', pattern: /encrypt/i, flags: ['--no-compress'], others: [/compress/i, /push.?mode/i, /max.?ram|memory/i] },
    { setting: 'compression', pattern: /compress/i, flags: ['--no-enc', '--compress'], others: [/push.?mode/i, /max.?ram|memory/i] },
    { setting: 'push mode', pattern: /push.?mode/i, flags: ['--no-enc', '--no-compress', '--push-mode', 'overwrite'], others: [/compress/i, /max.?ram|memory/i] },
    { setting: 'memory limit', pattern: /max.?ram|memory/i, flags: ['--no-enc', '--no-compress', '--max-ram', '512'], others: [/compress/i, /push.?mode/i] },
  ];

  it.each(SETTING_MISMATCHES)('should refuse a --ci resume whose $setting differs from the recorded one', async ({ pattern, flags, others }) => {
    await writeConfig(root, unfinishedConfig());
    const before = await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8');

    const result = await runCmd(['--cwd', root, 'init', 'docs', '--ci', ...flags, '--data-shards', '2', '--parity-shards', '1', '--provider', spec('p1'), '--provider', spec('p2'), '--provider', spec('p3')]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toMatch(pattern);
    for (const other of others) expect(capture.errors.join('\n')).not.toMatch(other);
    expect(await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8')).toBe(before);
    expect(probeCalls.size).toBe(0);
  });

  // The command line names the whole pool. One that leaves out a recorded storage
  // would end with more storages than the scheme, so it is refused, naming the
  // storage left out.
  it('should refuse a --ci resume whose storage list leaves out a recorded storage', async () => {
    await writeConfig(root, unfinishedConfig());
    const before = await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8');

    const result = await runCmd(['--cwd', root, 'init', 'docs', '--ci', '--no-enc', '--no-compress', '--data-shards', '2', '--parity-shards', '1', '--provider', spec('p2'), '--provider', spec('p3'), '--provider', spec('p4')]);

    expect(result).toBe('abort');
    expect(capture.errors.join('\n')).toMatch(/\bp1\b/);
    expect(await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8')).toBe(before);
    expect(probeCalls.size).toBe(0);
  });
});
