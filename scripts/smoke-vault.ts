import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
// Side-effect: registers the "local" type in ProviderRegistry
import '../src/providers/local-fs.js';
import { createMockProviderIO } from '../src/providers/provider.js';
import type { ProviderConfig } from '../src/types/index.js';
import { PushMode } from '../src/types/index.js';
import { init } from '../src/vault/vault-manager.js';
import { assert, runBfs } from './smoke-runner.js';
import type { SmokeContext } from './smoke-types.js';

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Computes SHA-256 for all files in a directory (recursively).
 *
 * @param dir  - Base directory
 * @param base - Relative path prefix (used internally during recursion)
 * @returns    Map of relativePath → SHA-256 hex
 */
export async function hashDir(
  dir: string,
  base = '',
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await hashDir(full, rel);
      for (const [k, v] of sub) result.set(k, v);
    } else {
      const buf = await fs.readFile(full);
      result.set(rel, sha256(buf));
    }
  }
  return result;
}

/**
 * Creates test files in sourceDir and returns their SHA-256 map.
 */
export async function createTestFiles(
  dir: string,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const write = async (rel: string, content: Buffer): Promise<void> => {
    const full = path.join(dir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    hashes.set(rel, sha256(content));
  };

  await write('hello.txt', Buffer.from('Hello, World!'));
  await write('readme.md', Buffer.from('# BFS Smoke Test\nLine 2\nLine 3'));
  await write('data.bin', crypto.randomBytes(256));
  await write('subdir/nested.txt', Buffer.from('Nested content'));
  await write('subdir/deep/file.txt', Buffer.from('Deep nested'));

  return hashes;
}

/**
 * Initialises the vault programmatically (bypasses interactive Inquirer.js).
 * Uses 3 LocalFS providers, scheme N=2, K=1.
 */
export async function setupVault(ctx: SmokeContext): Promise<void> {
  const { io } = createMockProviderIO();
  const providers: ProviderConfig[] = [
    {
      id: 'p1',
      type: 'local',
      adapterPackage: null,
      config: { path: ctx.provider1Dir },
    },
    {
      id: 'p2',
      type: 'local',
      adapterPackage: null,
      config: { path: ctx.provider2Dir },
    },
    {
      id: 'p3',
      type: 'local',
      adapterPackage: null,
      config: { path: ctx.provider3Dir },
    },
  ];

  await init(ctx.vaultDir, {
    vault_name: 'smoke-vault',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    push_mode: PushMode.NewVersion,
    providers,
    io,
  });
}

/** Returns true if the path exists, without throwing. */
export async function fileExists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

/** Reads and parses a JSON file. */
export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
}

/**
 * Builds args for `bfs init --ci` with local providers (scheme 2+1).
 *
 * @param vaultName - Vault name (positional argument)
 * @param providers - List of {id, dir} — one entry per provider
 * @param extra     - Additional flags, e.g. ['--no-compress']
 * @returns         Argument array ready to pass to runBfs
 */
export function buildInitArgs(
  vaultName: string,
  providers: Array<{ id: string; dir: string }>,
  extra: string[] = [],
): string[] {
  return [
    'init',
    vaultName,
    '--ci',
    '--data-shards',
    '2',
    '--parity-shards',
    '1',
    ...providers.flatMap(({ id, dir }) => [
      '--provider',
      `local:${id} --path ${dir}`,
    ]),
    ...extra,
  ];
}

/**
 * Creates an isolated vault for testing:
 * mkdir vaultDir + each provider dir, createTestFiles, bfs init --ci, assert exit 0.
 *
 * @param vaultDir  - Vault directory (will be created)
 * @param vaultName - Vault name passed to bfs init
 * @param providers - List of {id, dir} providers
 * @param extra     - Additional flags for bfs init (e.g. ['--no-compress'])
 * @returns         SHA-256 map of test files
 * @throws          When bfs init exits with a non-zero code
 */
export async function initTestVault(
  vaultDir: string,
  vaultName: string,
  providers: Array<{ id: string; dir: string }>,
  extra: string[] = [],
): Promise<Map<string, string>> {
  await Promise.all(
    [vaultDir, ...providers.map((p) => p.dir)].map((d) =>
      fs.mkdir(d, { recursive: true }),
    ),
  );
  const hashes = await createTestFiles(vaultDir);
  const r = runBfs(buildInitArgs(vaultName, providers, extra), vaultDir);
  assert(
    r.status === 0,
    `bfs init exit ${r.status ?? 'null'}\n${r.stdout}\n${r.stderr}`,
  );
  return hashes;
}

/**
 * Verifies SHA-256 of restored files against the original hash map.
 *
 * @param vaultDir - Vault directory (files are restored here)
 * @param hashes   - Map of relativePath → SHA-256 hex
 * @param label    - Label for error messages (e.g. "after pull")
 * @throws         When a file is missing or its SHA-256 does not match
 */
export async function verifyShaHashes(
  vaultDir: string,
  hashes: Map<string, string>,
  label = 'after pull',
): Promise<void> {
  for (const [rel, expectedHash] of hashes) {
    const buf = await fs.readFile(path.join(vaultDir, rel)).catch(() => null);
    assert(buf !== null, `file missing ${label}: ${rel}`);
    const actual = sha256(buf as Buffer);
    assert(
      actual === expectedHash,
      `SHA mismatch dla ${rel}: expected ${expectedHash}, got ${actual}`,
    );
  }
}
