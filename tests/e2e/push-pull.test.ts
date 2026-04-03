/**
 * E2E tests — full pipeline: init → push → pull → verify.
 *
 * Scenariusze realizowane jeden po jednym.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Side-effect import: rejestruje typ "local" w ProviderRegistry
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listManifests, readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { readState } from '../../src/vault/state.js';
import {
  init,
  listVersions,
  prune,
  pull,
  push,
  removeProvider,
} from '../../src/vault/vault-manager.js';
import { verifyAll } from '../../src/vault/verify.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-e2e-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', config: { path: dir } };
}

function mockIO(answers: Record<string, string> = {}): ProviderIO {
  return createMockProviderIO(answers).io;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** ProviderIO który zawsze akceptuje potwierdzenia (confirm → true). */
function yesIO(): ProviderIO {
  const base = createMockProviderIO();
  return { ...base.io, confirm: async () => true };
}

/**
 * Tworzy 10 plików testowych: tekst, binary, zagnieżdżone katalogi.
 * Zwraca mapę relativePath → SHA-256 do porównania byte-for-byte.
 */
async function createTestFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  const write = async (rel: string, content: Buffer): Promise<void> => {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    hashes.set(rel, sha256(content));
  };

  await write('hello.txt', Buffer.from('Hello, World!'));
  await write('readme.md', Buffer.from('# BFS E2E Test\nLine 2\nLine 3'));
  await write('data.bin', crypto.randomBytes(1024));
  await write('subdir/nested.txt', Buffer.from('Nested content'));
  await write('subdir/deep/file.txt', Buffer.from('Deep nested'));
  await write('subdir/binary.bin', crypto.randomBytes(512));
  await write('empty.txt', Buffer.from(''));
  await write('unicode.txt', Buffer.from('Zażółć gęślą jaźń 🎉'));
  await write('numbers.csv', Buffer.from('1,2,3\n4,5,6\n7,8,9'));
  await write('config.json', Buffer.from('{"key":"value","num":42}'));

  return hashes;
}

/**
 * Odczytuje wszystkie pliki użytkownika (pomija .bfs/ i .bfsignore)
 * i zwraca mapę relativePath → SHA-256.
 */
async function hashAllFiles(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  async function scan(d: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.bfs' || e.name === '.bfsignore') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await scan(path.join(d, e.name), rel);
      } else {
        const content = await fs.readFile(path.join(d, e.name));
        result.set(rel, sha256(content));
      }
    }
  }

  await scan(dir, '');
  return result;
}

/** Porównuje pliki w katalogu z oczekiwaną mapą SHA-256. */
async function assertFilesMatch(
  destDir: string,
  expected: Map<string, string>,
): Promise<void> {
  const actual = await hashAllFiles(destDir);
  for (const [rel, expectedHash] of expected) {
    expect(actual.get(rel), `Plik ${rel}: brakuje lub hash niezgodny`).toBe(
      expectedHash,
    );
  }
  expect(actual.size).toBe(expected.size);
}

/** Sprawdza czy shard istnieje na providerze. */
async function shardExists(
  providerDir: string,
  vaultName: string,
  shardIndex: number,
  version: number,
): Promise<boolean> {
  try {
    await fs.access(
      path.join(providerDir, vaultName, `shard_${shardIndex}.bfs.${version}`),
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Scenariusz 1: BEZ szyfrowania, 3/1, 4 local providery ─────────────────

describe('Scenariusz 1: brak szyfrowania, schemat 3/1, RS repair z 3 z 4 shardów', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should create 4 shards across 4 providers after push', async () => {
    await init(root, {
      vault_name: 'test-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO() });

    for (let i = 0; i < 4; i++) {
      expect(await shardExists(pdirs[i] ?? '', 'test-vault', i, 1)).toBe(true);
    }
  });

  it('should restore 10 files byte-for-byte from 3 of 4 shards (RS repair)', async () => {
    await init(root, {
      vault_name: 'test-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Symuluj awarię 1 nośnika: usuń shard_0 z p0
    await fs.rm(path.join(pdirs[0] ?? '', 'test-vault', 'shard_0.bfs.1'));

    // Pull do nowego katalogu
    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), {
        recursive: true,
      });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 2: Z szyfrowaniem, 5/2 (7 providerów), pull z 2 brakującymi ─

describe('Scenariusz 2: szyfrowanie, schemat 5/2, RS repair z 5 z 7 shardów', () => {
  let root: string;
  let pdirs: string[];
  const PASSWORD = 'super-secret-pass-123';

  beforeEach(async () => {
    root = await tmp();
    pdirs = [];
    for (let i = 0; i < 7; i++) pdirs.push(await tmp());
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should create 7 shards after encrypted push', async () => {
    await init(root, {
      vault_name: 'enc-vault',
      scheme: { data_shards: 5, parity_shards: 2 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    for (let i = 0; i < 7; i++) {
      expect(await shardExists(pdirs[i] ?? '', 'enc-vault', i, 1)).toBe(true);
    }
  });

  it('should restore files byte-for-byte with encryption and 2 missing shards', async () => {
    await init(root, {
      vault_name: 'enc-vault',
      scheme: { data_shards: 5, parity_shards: 2 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    // Symuluj awarię 2 nośników
    await fs.rm(path.join(pdirs[0] ?? '', 'enc-vault', 'shard_0.bfs.1'));
    await fs.rm(path.join(pdirs[5] ?? '', 'enc-vault', 'shard_5.bfs.1'));

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), {
        recursive: true,
      });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 3: Wersjonowanie i przywracanie wersji ───────────────────────

describe('Scenariusz 3: wersjonowanie i przywracanie wersji', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 3/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should track state correctly across push/pull/push cycles', async () => {
    await init(root, {
      vault_name: 'ver-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    // v1: oryginalne pliki
    const v1Hashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    let state = await readState(root);
    expect(state.latest_version).toBe(1);
    expect(state.working_version).toBe(1);

    // Modyfikacja dla v2
    await fs.writeFile(path.join(root, 'hello.txt'), 'Modified in v2');
    await fs.writeFile(path.join(root, 'new-file.txt'), 'Added in v2');
    const v2HelloHash = sha256(Buffer.from('Modified in v2'));
    const v2NewFileHash = sha256(Buffer.from('Added in v2'));

    await push(root, { io: mockIO() });

    state = await readState(root);
    expect(state.latest_version).toBe(2);
    expect(state.working_version).toBe(2);

    // Pull --version 1 → oryginalne pliki
    await pull(root, { version: 1, io: mockIO(), force: true });

    state = await readState(root);
    expect(state.latest_version).toBe(2);
    expect(state.working_version).toBe(1);

    let files = await hashAllFiles(root);
    expect(files.get('hello.txt')).toBe(v1Hashes.get('hello.txt'));
    // Spec (pipeline.md krok 11): --force → usuń WSZYSTKO poza .bfs/ przed rozpakowaniem
    expect(files.has('new-file.txt')).toBe(false);

    // Pull bez --version → najnowsza (v2)
    await pull(root, { io: mockIO(), force: true });

    state = await readState(root);
    expect(state.latest_version).toBe(2);
    expect(state.working_version).toBe(2);

    files = await hashAllFiles(root);
    expect(files.get('hello.txt')).toBe(v2HelloHash);
    expect(files.get('new-file.txt')).toBe(v2NewFileHash);

    // Pull v1 → push → tworzy v3
    // yesIO() bo working_version(1) < latest_version(2) → push pyta o potwierdzenie
    await pull(root, { version: 1, io: mockIO(), force: true });
    await push(root, { io: yesIO() });

    state = await readState(root);
    expect(state.latest_version).toBe(3);
    expect(state.working_version).toBe(3);

    const versions = await listVersions(root);
    expect(versions).toHaveLength(3);

    // Prune v1 → shardy v1 usunięte
    await prune(root, { versions: [1] });

    expect(await readManifest(root, 1)).toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(await shardExists(pdirs[i] ?? '', 'ver-vault', i, 1)).toBe(false);
    }
    // v2 nadal istnieje
    for (let i = 0; i < 4; i++) {
      expect(await shardExists(pdirs[i] ?? '', 'ver-vault', i, 2)).toBe(true);
    }
  });
});

// ─── Scenariusz 4: Pull z istniejącym .bfs/ (auto-discovery providerów) ──────

describe('Scenariusz 4: pull z istniejącym .bfs/ — providery z config, bez pytań', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 3/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should pull without specifying providers — config knows them', async () => {
    await init(root, {
      vault_name: 'auto-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Usuń pliki użytkownika, zachowaj .bfs/
    for (const rel of originalHashes.keys()) {
      await fs.rm(path.join(root, rel), { force: true });
    }

    // Pull wersji 1 — bez podawania danych providerów
    await pull(root, { version: 1, io: mockIO(), force: true });

    await assertFilesMatch(root, originalHashes);

    const state = await readState(root);
    expect(state.working_version).toBe(1);
    expect(state.latest_version).toBe(1);
  });
});

// ─── Scenariusz 5: Duże pliki (50 MB) ────────────────────────────────────────

describe('Scenariusz 5: duży plik 50 MB', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should push and pull 50 MB file with SHA-256 verification', {
    timeout: 60_000,
  }, async () => {
    await init(root, {
      vault_name: 'large-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const bigData = crypto.randomBytes(50 * 1024 * 1024);
    const bigHash = sha256(bigData);
    await fs.writeFile(path.join(root, 'bigfile.bin'), bigData);

    await push(root, { io: mockIO() });

    await fs.rm(path.join(root, 'bigfile.bin'));

    await pull(root, { io: mockIO(), force: true });

    const restored = await fs.readFile(path.join(root, 'bigfile.bin'));
    expect(sha256(restored)).toBe(bigHash);
    expect(restored.length).toBe(50 * 1024 * 1024);
  });
});

// ─── Scenariusz 6: Verify + health check ─────────────────────────────────────

describe('Scenariusz 6: verify i health check', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 3/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should detect healthy → degraded → damaged after removing shards', async () => {
    await init(root, {
      vault_name: 'health-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Wszystkie shardy → healthy
    let report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');

    // Usuń shard_0 → degraded (K=1 parity, tolerancja: 0)
    await fs.rm(path.join(pdirs[0] ?? '', 'health-vault', 'shard_0.bfs.1'));

    report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('degraded');
    // Spec: degraded → tolerancja = dostępne - N = 3 - 3 = 0
    expect(report.versions[0]?.tolerance).toBe(0);

    // Usuń shard_1 → damaged (brakuje > K shardów)
    await fs.rm(path.join(pdirs[1] ?? '', 'health-vault', 'shard_1.bfs.1'));

    report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('damaged');

    // Manifest zaktualizowany
    const manifest = await readManifest(root, 1);
    expect(manifest?.health).toBe('damaged');
  });
});

// ─── Scenariusz 7: Provider remove + heal (strategy: rebuild) ────────────────

describe('Scenariusz 7: provider remove + heal — verify healthy, pull poprawny', () => {
  let root: string;
  let pdirs: string[];
  let spareDir: string;

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 3/1
    spareDir = await tmp();
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs, spareDir])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should heal shard to new provider and keep all versions healthy', async () => {
    await init(root, {
      vault_name: 'heal-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() }); // v1
    await push(root, { io: mockIO() }); // v2

    // Dodaj spare provider do config przed rebuild
    const config = await readConfig(root);
    if (!config) throw new Error('Config missing');
    config.providers.push(localProvider('spare', spareDir));
    await writeConfig(root, config);

    // Usuń p0, odbuduj shard na spare
    await removeProvider(root, 'p0', {
      strategy: 'rebuild',
      targetProviderId: 'spare',
      rebuildScope: 'all',
      io: mockIO(),
    });

    // Obie wersje healthy
    const report = await verifyAll(root, mockIO());
    for (const vs of report.versions) {
      expect(vs.health).toBe('healthy');
    }

    // Pull → pliki poprawne
    await pull(root, { io: mockIO(), force: true });
    await assertFilesMatch(root, originalHashes);

    // spare ma odbudowane shardy dla obu wersji
    expect(await shardExists(spareDir, 'heal-vault', 0, 1)).toBe(true);
    expect(await shardExists(spareDir, 'heal-vault', 0, 2)).toBe(true);
  });
});

// ─── Scenariusz 8: Manifesty z różnymi schematami per wersja ─────────────────

describe('Scenariusz 8: różne schematy N/K per wersja', () => {
  let root: string;
  let pdirs: string[]; // 4 bazowe + 3 dodatkowe = 7

  beforeEach(async () => {
    root = await tmp();
    pdirs = [];
    for (let i = 0; i < 7; i++) pdirs.push(await tmp());
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should use correct schema per version when pulling old version', async () => {
    // v1: schemat 3/1, 4 providery
    await init(root, {
      vault_name: 'mixed-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.slice(0, 4).map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const v1Hashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Zmień schemat na 5/2 — dołóż 3 providery
    const config = await readConfig(root);
    if (!config) throw new Error('Config missing');
    config.scheme = { data_shards: 5, parity_shards: 2 };
    for (let i = 4; i < 7; i++) {
      config.providers.push(localProvider(`p${i}`, pdirs[i] ?? ''));
    }
    await writeConfig(root, config);

    await fs.writeFile(path.join(root, 'new-v2.txt'), 'Added in v2');
    const v2ExtraHash = sha256(Buffer.from('Added in v2'));

    await push(root, { io: mockIO() });

    // Sprawdź manifesty
    const m1 = await readManifest(root, 1);
    const m2 = await readManifest(root, 2);
    expect(m1?.scheme).toEqual({ data_shards: 3, parity_shards: 1 });
    expect(m1?.shards).toHaveLength(4);
    expect(m2?.scheme).toEqual({ data_shards: 5, parity_shards: 2 });
    expect(m2?.shards).toHaveLength(7);

    // Pull v1 → używa schematu 3/1 z manifestu v1
    await pull(root, { version: 1, io: mockIO(), force: true });
    const afterV1 = await hashAllFiles(root);
    expect(afterV1.get('hello.txt')).toBe(v1Hashes.get('hello.txt'));
    // Spec (pipeline.md krok 11): --force → usuń WSZYSTKO poza .bfs/ przed rozpakowaniem
    expect(afterV1.has('new-v2.txt')).toBe(false);

    const state = await readState(root);
    expect(state.working_version).toBe(1);
    expect(state.latest_version).toBe(2);

    // Pull latest (v2) → używa schematu 5/2
    await pull(root, { io: mockIO(), force: true });
    const afterV2 = await hashAllFiles(root);
    expect(afterV2.get('new-v2.txt')).toBe(v2ExtraHash);
  });
});

// ─── Scenariusz 9: Full disaster recovery ─────────────────────────────────────

describe('Scenariusz 9: full disaster recovery', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 3/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild .bfs/ and restore all 3 versions after full directory loss', async () => {
    await init(root, {
      vault_name: 'recovery-vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const v1Hashes = await createTestFiles(root);
    await push(root, { io: mockIO() }); // v1

    await fs.writeFile(path.join(root, 'v2-extra.txt'), 'v2 file');
    await push(root, { io: mockIO() }); // v2

    await fs.writeFile(path.join(root, 'v3-extra.txt'), 'v3 file');
    const v3ExtraHash = sha256(Buffer.from('v3 file'));
    await push(root, { io: mockIO() }); // v3

    // Katastrofa: usuń cały katalog roboczy
    await fs.rm(root, { recursive: true });
    await fs.mkdir(root);

    // Recovery — bootstrap z p0
    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(
      localProvider('p0', pdirs[0] ?? ''),
      bsIO,
    );
    await bootstrapProvider.authenticate();

    const report = await recover(root, {
      vaultName: 'recovery-vault',
      provider: bootstrapProvider,
      io: bsIO,
    });

    // .bfs/ odbudowane: 3 manifesty, config, state
    expect(report.manifests_rebuilt).toBe(3);

    const manifests = await listManifests(root);
    expect(manifests).toHaveLength(3);
    expect(manifests.map((m) => m.version)).toEqual([1, 2, 3]);

    const config = await readConfig(root);
    expect(config?.vault_name).toBe('recovery-vault');

    // State: latest=3, working=0 (nic nie rozpakowane)
    let state = await readState(root);
    expect(state.latest_version).toBe(3);
    expect(state.working_version).toBe(0);

    // Pull latest (v3)
    await pull(root, { io: mockIO(), force: true });

    const afterV3 = await hashAllFiles(root);
    expect(afterV3.get('v3-extra.txt')).toBe(v3ExtraHash);
    expect(afterV3.has('hello.txt')).toBe(true);

    state = await readState(root);
    expect(state.working_version).toBe(3);

    // Pull --version 1 → pliki z v1
    await pull(root, { version: 1, io: mockIO(), force: true });
    const afterV1Pull = await hashAllFiles(root);
    expect(afterV1Pull.get('hello.txt')).toBe(v1Hashes.get('hello.txt'));

    state = await readState(root);
    expect(state.working_version).toBe(1);
    expect(state.latest_version).toBe(3);
  });
});

// ─── Scenariusz 8: --password override przy encryption.enabled=false ────────

describe('Scenariusz 8: --password override przy encryption.enabled=false', () => {
  const PASSWORD = 'override-pass-456';
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs])
      await fs.rm(d, { recursive: true, force: true });
  });

  it('should encrypt when --password provided despite config encryption disabled', async () => {
    await init(root, {
      vault_name: 'pw-override',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    const manifests = await listManifests(root);
    expect(manifests).toHaveLength(1);
    const manifest = await readManifest(root, 1);
    expect(manifest).not.toBeNull();
    expect(manifest?.encrypted).toBe(true);
    expect(manifest?.encrypted_per_shard).toBe(true);
  });

  it('should roundtrip correctly: push --password (enc disabled) → pull --password', async () => {
    await init(root, {
      vault_name: 'pw-override',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), {
        recursive: true,
      });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});
