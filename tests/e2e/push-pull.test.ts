/**
 * E2E tests — full pipeline: init → push → pull → verify.
 *
 * Scenariusze realizowane jeden po jednym.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cryptoModule from '../../src/core/crypto.js';
import { BfsError, DecryptionError } from '../../src/core/errors.js';
import { computeShardHeaderSize } from '../../src/core/shard-io.js';
// Side-effect import: rejestruje typ "local" w ProviderRegistry
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { listManifests, readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { readState } from '../../src/vault/state.js';
import { init, listVersions, prune, pull, push, removeProvider } from '../../src/vault/vault-manager.js';
import { verifyAll } from '../../src/vault/verify.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-e2e-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
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
async function assertFilesMatch(destDir: string, expected: Map<string, string>): Promise<void> {
  const actual = await hashAllFiles(destDir);
  for (const [rel, expectedHash] of expected) {
    expect(actual.get(rel), `Plik ${rel}: brakuje lub hash niezgodny`).toBe(expectedHash);
  }
  expect(actual.size).toBe(expected.size);
}

/** Sprawdza czy shard istnieje na providerze. */
async function shardExists(providerDir: string, vaultName: string, shardIndex: number, version: number): Promise<boolean> {
  try {
    await fs.access(path.join(providerDir, vaultName, `shard_${shardIndex}.bfs.${version}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Corrupts a shard file in place with a length-preserving bit-flip in the middle
 * of its payload. The trailing SHA-256 is deliberately NOT recomputed, so the
 * shard reads as corrupt — for an encrypted shard the flip also breaks the
 * per-shard GCM auth tag. Mirrors the cli-e2e corrupt-shard driver.
 */
async function corruptShardPayload(shardPath: string): Promise<void> {
  const shard = await fs.readFile(shardPath);
  const headerSize = computeShardHeaderSize(shard);
  const payloadEnd = shard.length - 32; // exclusive; leave the trailing checksum intact
  const pos = headerSize + Math.floor((payloadEnd - headerSize) / 2);
  shard.writeUInt8(shard.readUInt8(pos) ^ 0x01, pos);
  await fs.writeFile(shardPath, shard);
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should push and pull 50 MB file with SHA-256 verification', { timeout: 60_000 }, async () => {
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
    for (const d of [root, ...pdirs, spareDir]) await fs.rm(d, { recursive: true, force: true });
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
    await removeProvider(root, 'p0', { strategy: 'rebuild', targetProviderId: 'spare', rebuildScope: 'all', io: mockIO() });

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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
    const bootstrapProvider = new LocalFsProvider(localProvider('p0', pdirs[0] ?? ''), bsIO);
    await bootstrapProvider.authenticate();

    const report = await recover(root, { vaultName: 'recovery-vault', provider: bootstrapProvider, io: bsIO });

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

// ─── Scenariusz 9: Kompresja ZIP — roundtrip bez szyfrowania ─────────────────

describe('Scenariusz 9: kompresja ZIP, brak szyfrowania, 2/1', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should roundtrip byte-for-byte with compression enabled', async () => {
    await init(root, {
      vault_name: 'zip-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    const manifests = await listManifests(root);
    expect(manifests).toHaveLength(1);
    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBe(true);

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should write compressed=true in manifest and blob_size_uncompressed', async () => {
    await init(root, {
      vault_name: 'zip-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO() });

    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBe(true);
    expect(typeof manifest?.blob_size_uncompressed).toBe('number');
    expect((manifest?.blob_size_uncompressed ?? 0) > 0).toBe(true);
  });

  it('should push --no-compress override to disable compression per-push', async () => {
    await init(root, {
      vault_name: 'zip-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), compressOverride: false });

    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBeUndefined();

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, await hashAllFiles(root));
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should push --compress override to enable compression per-push when config has it off', async () => {
    await init(root, {
      vault_name: 'zip-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), compressOverride: true });

    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBe(true);

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, await hashAllFiles(root));
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 10: Kompresja ZIP + szyfrowanie — roundtrip ──────────────────

describe('Scenariusz 10: kompresja ZIP + szyfrowanie, 2/1', () => {
  const PASSWORD = 'zip-enc-pass-789';
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should roundtrip byte-for-byte with compression + encryption', async () => {
    await init(root, {
      vault_name: 'zip-enc-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: true, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO({ password: PASSWORD }),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBe(true);
    expect(manifest?.encrypted).toBe(true);

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 11: Wsteczna kompatybilność — blob bez flagi COMPRESSED ──────

describe('Scenariusz 11: wsteczna kompatybilność — brak kompresji w konfiguracji', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should roundtrip without compression flag set (legacy blob)', async () => {
    await init(root, {
      vault_name: 'legacy-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      compression: { enabled: false, algorithm: 'deflate' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    const manifest = await readManifest(root, 1);
    expect(manifest?.compressed).toBeUndefined();

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
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
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
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
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 9: --password na unencrypted vault = silent no-op ───────────

describe('Scenariusz 9: --password na unencrypted vault = silent no-op', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should ignore --password on unencrypted manifest (deriveKey not called, files restored)', async () => {
    await init(root, {
      vault_name: 'plain-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    const manifest = await readManifest(root, 1);
    expect(manifest?.encrypted).toBe(false);

    const deriveKeySpy = vi.spyOn(cryptoModule, 'deriveKey');

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, password: 'irrelevant-password' });
      await assertFilesMatch(dest, originalHashes);
      expect(deriveKeySpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 10: pull bez password na encrypted manifest fails czytelnie ─

describe('Scenariusz 10: pull bez password na encrypted manifest fails czytelnie', () => {
  const PASSWORD = 'enc-pass-789';
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should throw BfsError when no password provided for encrypted manifest', async () => {
    await init(root, {
      vault_name: 'enc-no-pwd',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      // mockIO without answers → askSecret returns '' → pull of an encrypted
      // backup with no password rejects.
      await expect(pull(dest, { io: mockIO(), force: true })).rejects.toThrow(BfsError);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 11: mixed-version vault — per-version encryption dispatch ───

describe('Scenariusz 11: mixed-version vault — pull respektuje per-version encryption', () => {
  const V2_PASSWORD = 'enc-v2-pwd';
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  async function setupMixedVault(): Promise<{ v1Hashes: Map<string, string>; v2Hashes: Map<string, string> }> {
    await init(root, {
      vault_name: 'mixed-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const v1Hashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    const cfg = await readConfig(root);
    if (!cfg) throw new Error('readConfig returned null after init');
    cfg.encryption.enabled = true;
    await writeConfig(root, cfg);

    // Mutuj jeden plik, żeby v2 różnił się od v1 i było widać że pull v2
    // przywraca v2-stan (nie v1).
    const v2HelloContent = Buffer.from('v2 content');
    await fs.writeFile(path.join(root, 'hello.txt'), v2HelloContent);
    const v2Hashes = new Map(v1Hashes);
    v2Hashes.set('hello.txt', sha256(v2HelloContent));
    await push(root, { io: mockIO(), password: V2_PASSWORD });

    const m1 = await readManifest(root, 1);
    const m2 = await readManifest(root, 2);
    expect(m1?.encrypted).toBe(false);
    expect(m2?.encrypted).toBe(true);

    return { v1Hashes, v2Hashes };
  }

  it('should pull v1 (unencrypted) without password', async () => {
    const { v1Hashes } = await setupMixedVault();
    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, version: 1 });
      await assertFilesMatch(dest, v1Hashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should pull v2 (encrypted) with correct password', async () => {
    const { v2Hashes } = await setupMixedVault();
    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, version: 2, password: V2_PASSWORD });
      await assertFilesMatch(dest, v2Hashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should reject pull v2 without password', async () => {
    await setupMixedVault();
    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await expect(pull(dest, { io: mockIO(), force: true, version: 2 })).rejects.toThrow(BfsError);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should ignore --password on v1 (unencrypted) — deriveKey not called', async () => {
    const { v1Hashes } = await setupMixedVault();
    const deriveKeySpy = vi.spyOn(cryptoModule, 'deriveKey');
    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, version: 1, password: 'irrelevant' });
      await assertFilesMatch(dest, v1Hashes);
      expect(deriveKeySpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 13: pull --allow-missing-adapters z brakującym external adapterem ─
//
// Regresja: `pull --allow-missing-adapters` z brakującym ZEWNĘTRZNYM adapterem
// wywraca cały pull błędem BfsError("Unknown provider type: ...") zamiast pominąć
// ten shard i zdekodować z pozostałych N providerów. CHANGELOG [0.5.0] obiecuje, że
// flaga pozwala RS dekodować z providerów, które pozostają osiągalne — recovery
// robi to dobrze (bootstrap connectOne: create w try/catch → null → skip), pull nie.
//
// Setup mirroruje realną sytuację: adapter był obecny przy push, odinstalowany
// przed pull. Push 3 local → shardy na dysku. Potem mutacja config.json: jeden
// provider dostaje nieistniejący typ external (`ghost-ssh`) z niepustym
// adapterPackage (klasyfikacja jako external-missing w detectMissingAdapters);
// jego plik sharda zostaje nietknięty. pull --allow-missing-adapters ma pominąć
// brakujący provider i odtworzyć z 2 pozostałych local (N=2). Przed fixem:
// providerRegistry.create() na niezarejestrowanym typie rzuca POZA try → crash.
describe('Scenariusz 13: pull --allow-missing-adapters z brakującym external adapterem', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should skip the missing external adapter and restore from remaining N providers', async () => {
    await init(root, {
      vault_name: 'ghost-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Mutate config AFTER a successful push: provider p2 becomes an external
    // type whose adapter is not registered. Its shard file stays on disk
    // untouched — only the config classifies it as external-missing.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('readConfig returned null after init');
    const ghost = cfg.providers.find((p) => p.id === 'p2');
    if (!ghost) throw new Error('provider p2 not found in config');
    ghost.type = 'ghost-ssh';
    ghost.adapterPackage = 'bfs-adapter-ghost@1.0.0';
    await writeConfig(root, cfg);

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });

      // With allowMissingAdapters: pull must NOT throw "Unknown provider type",
      // must skip p2/ghost-ssh, RS-decode from p0+p1 (N=2 available), restore all.
      await pull(dest, { io: mockIO(), force: true, allowMissingAdapters: true });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should abort in preflight without --allow-missing-adapters (contrast)', async () => {
    await init(root, {
      vault_name: 'ghost-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO() });

    const cfg = await readConfig(root);
    if (!cfg) throw new Error('readConfig returned null after init');
    const ghost = cfg.providers.find((p) => p.id === 'p2');
    if (!ghost) throw new Error('provider p2 not found in config');
    ghost.type = 'ghost-ssh';
    ghost.adapterPackage = 'bfs-adapter-ghost@1.0.0';
    await writeConfig(root, cfg);

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });

      // Without the flag the preflight rejects cleanly with the install hint —
      // this path already works and proves the missing adapter is detected.
      await expect(pull(dest, { io: mockIO(), force: true })).rejects.toThrow(BfsError);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// ─── Scenariusz 12: pull ze złym hasłem na encrypted vault ───────────────────
//
// Regresja: zły klucz wywoływał DecryptionError w `flush` KAŻDEGO z N+K
// równoległych strumieni deszyfrujących. Tylko shard aktywnie czytany przez
// rsDecodeStriped surfował błąd czysto przez pipeline; pozostałe (sibling)
// emitowały zdarzenie 'error' bez listenera → Node rzucał uncaught exception
// (zrzut stosu do usera) zamiast czystego komunikatu. Test wymusza ścieżkę V2 z
// wieloma shardami (wszystkie obecne, złe hasło): przed fixem wywraca workera
// nieobsłużonym 'error', po fixie odrzuca jednym DecryptionError.
describe('Scenariusz 12: pull ze złym hasłem na encrypted vault', () => {
  let root: string;
  let pdirs: string[];
  const PASSWORD = 'correct-horse-battery';

  beforeEach(async () => {
    root = await tmp();
    pdirs = [];
    for (let i = 0; i < 5; i++) pdirs.push(await tmp());
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should reject with DecryptionError (no unhandled stream error) on wrong password', async () => {
    await init(root, {
      vault_name: 'enc-wrong-pwd',
      scheme: { data_shards: 3, parity_shards: 2 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });

      // All N+K shards present, but the wrong password → every shard's GCM
      // check fails. Must surface as a single DecryptionError, never an
      // uncaught 'error' event from a sibling decrypt stream.
      await expect(pull(dest, { io: mockIO(), force: true, password: 'wrong-password' })).rejects.toThrow(DecryptionError);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});

// Corrupt-but-present shard → reconstruct from parity.
//
// Regression (critical bug): V2 pull tolerated a MISSING shard (reconstruct
// from parity) but not a CORRUPT one — a single rotten-but-present shard sank
// the whole restore (trailing SHA / GCM auth tag → output.destroy) even though
// N healthy shards + parity were more than enough. Fix: pre-validate every
// shard before decode → a corrupt shard is treated like a missing one and
// erasure-decoded from the rest. The bit-flip preserves length, targeting the
// corruption that got=0 (a missing shard) does NOT represent.
describe('pull with a corrupt shard reconstructs from parity', () => {
  const PASSWORD = 'corrupt-shard-pass-321';
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()]; // 2/1
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should exclude a corrupt data shard and reconstruct from parity (encrypted)', async () => {
    await init(root, {
      vault_name: 'corrupt-data',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    // Corrupt data shard 0; shard 1 (data) + shard 2 (parity) stay healthy —
    // exactly N=2 good shards, enough to reconstruct the excluded one.
    await corruptShardPayload(path.join(pdirs[0] ?? '', 'corrupt-data', 'shard_0.bfs.1'));

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should exclude a corrupt data shard and reconstruct from parity (unencrypted)', async () => {
    await init(root, {
      vault_name: 'corrupt-plain',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO() });

    // No encryption: the only integrity guard is the trailing SHA-256 (no GCM),
    // exercising the encKey===undefined branch of _validateShardIntegrity.
    await corruptShardPayload(path.join(pdirs[0] ?? '', 'corrupt-plain', 'shard_0.bfs.1'));

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });

  it('should exclude a corrupt parity shard and still restore (encrypted)', async () => {
    await init(root, {
      vault_name: 'corrupt-parity',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const originalHashes = await createTestFiles(root);
    await push(root, { io: mockIO(), password: PASSWORD });

    // Corrupt the parity shard (index 2 = N..N+K-1); both data shards stay
    // healthy. The unneeded-but-corrupt parity must be excluded, not abort.
    await corruptShardPayload(path.join(pdirs[2] ?? '', 'corrupt-parity', 'shard_2.bfs.1'));

    const dest = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(dest, '.bfs'), { recursive: true });
      await pull(dest, { io: mockIO(), force: true, password: PASSWORD });
      await assertFilesMatch(dest, originalHashes);
    } finally {
      await fs.rm(dest, { recursive: true, force: true });
    }
  });
});
