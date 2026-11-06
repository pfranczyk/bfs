import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, UnsafePathError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import { buildShard, parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { CliProviderInput, ProviderConfig, ProviderIO, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';

function cliInput(overrides: Partial<CliProviderInput> = {}): CliProviderInput {
  return { name: overrides.name ?? 'test', rawArgs: overrides.rawArgs ?? [] };
}

// --- Helpers ------------------------------------------------------------------

/**
 * Scratch directories handed out by writeConfigFile, emptied after every test -
 * so a path it returns must not be used outside the test that asked for it.
 */
const configDirs: string[] = [];

afterEach(async () => {
  // Swallow removal errors: a test that already passed must not turn red because
  // something else on the machine still held the file for a moment.
  await Promise.all(configDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => {})));
});

/** Writes `content` as cfg.json in a fresh temp directory and returns the file path. */
async function writeConfigFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-loc-'));
  configDirs.push(dir);
  const file = path.join(dir, 'cfg.json');
  await fs.writeFile(file, content, 'utf8');
  return file;
}

/**
 * ProviderIO answering the path prompt from `replies` in order, confirming
 * everything, and recording what reached the operator. A prompt beyond the last
 * reply throws, so a flow that keeps re-asking fails with a reason instead of
 * spinning until the test times out.
 */
function scriptedIO(replies: readonly string[]): { io: ProviderIO; warns: string[]; asked: () => number; confirms: () => number } {
  const { io: base } = createMockProviderIO();
  const warns: string[] = [];
  let asked = 0;
  let confirms = 0;
  const io: ProviderIO = {
    ...base,
    async ask(): Promise<string> {
      const reply = replies[asked];
      asked += 1;
      if (reply === undefined) throw new Error(`path prompt asked ${asked} times, only ${replies.length} replies scripted`);
      return reply;
    },
    async confirm(): Promise<boolean> {
      confirms += 1;
      return true;
    },
    warn(message: string): void {
      warns.push(message);
    },
  };
  return { io, warns, asked: () => asked, confirms: () => confirms };
}

/**
 * The single warning the operator saw, with every path that runs on past
 * `filePath` (into its would-be `sub` directory) taken out. What is left names
 * `filePath` only if the warning names the FILE - not the path typed, and not a
 * parent of it that merely starts with the file's path.
 */
function warningNamingOnly(warns: readonly string[], filePath: string): string {
  expect(warns).toHaveLength(1);
  const warning = warns[0];
  assert(warning !== undefined, 'expected exactly one warning');
  return warning.split(path.join(filePath, 'sub')).join('');
}

function makeConfig(basePath: string, id = 'test-local'): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: basePath } };
}

const TEST_LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'test-local', provider_type: 'local', adapterPackage: null, connection_config: { path: '/tmp/test' }, required_inputs: [], remote_path: '/tmp/test/vault/shard_0.bfs.1', shard_hash: 'a'.repeat(64) },
];

function makeHeader(overrides: Partial<ShardHeader> = {}): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 1,
    vault_id: '550e8400-e29b-41d4-a716-446655440000',
    vault_name: 'testvault',
    blob_size: 256n,
    blob_hash: 'b'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: null,
    map_length: 0,
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
}

/** Upload helper: wraps Buffer in Readable.from() as required by the new interface. */
async function uploadBuf(provider: LocalFsProvider, filename: string, data: Buffer) {
  return provider.upload(filename, Readable.from(data), data.length);
}

/** Download helper: collects the Readable stream into a Buffer. */
async function downloadBuf(provider: LocalFsProvider, ref: { provider_id: string; path: string }): Promise<Buffer> {
  return streamToBuffer(await provider.download(ref));
}

// --- Tests --------------------------------------------------------------------

describe('LocalFsProvider', () => {
  let tmpDir: string;
  let provider: LocalFsProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-'));
    const { io } = createMockProviderIO();
    provider = new LocalFsProvider(makeConfig(tmpDir), io);
    provider.setVaultName('testvault');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- upload / download ----------------------------------------------------

  it('should upload and download identical data', async () => {
    const data = Buffer.from('hello, shard data');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);
    expect(downloaded).toEqual(data);
  });

  it('should preserve binary data on upload/download', async () => {
    const data = Buffer.alloc(512);
    for (let i = 0; i < 512; i++) data[i] = i % 256;
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    const downloaded = await downloadBuf(provider, ref);
    expect(downloaded).toEqual(data);
  });

  it('should return hash in RemoteRef after upload', async () => {
    const data = Buffer.from('test');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', data);
    expect(ref.provider_id).toBe('test-local');
    expect(ref.path).toBe('shard_0.bfs.1');
    expect(ref.hash).toBeDefined();
    expect(ref.hash).toHaveLength(64); // SHA-256 hex
  });

  // --- list -----------------------------------------------------------------

  it('should list uploaded files', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('b'));
    const refs = await provider.list();
    const names = refs.map((r) => r.path).sort();
    expect(names).toEqual(['shard_0.bfs.1', 'shard_1.bfs.1']);
  });

  it('should filter list by prefix', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('a'));
    await uploadBuf(provider, 'shard_0.bfs.2', Buffer.from('b'));
    await uploadBuf(provider, 'shard_1.bfs.1', Buffer.from('c'));
    const refs = await provider.list('shard_0');
    expect(refs.map((r) => r.path).sort()).toEqual(['shard_0.bfs.1', 'shard_0.bfs.2']);
  });

  it('should return empty list when vault directory does not exist', async () => {
    const { io } = createMockProviderIO();
    const freshProvider = new LocalFsProvider(makeConfig(tmpDir), io);
    freshProvider.setVaultName('nonexistent-vault');
    const refs = await freshProvider.list();
    expect(refs).toEqual([]);
  });

  // --- delete ---------------------------------------------------------------

  it('should delete a file and remove it from list', async () => {
    const ref = await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('data'));
    await provider.delete(ref);
    const refs = await provider.list();
    expect(refs.map((r) => r.path)).not.toContain('shard_0.bfs.1');
  });

  // delete is idempotent: an already-absent shard is success (parity with
  // FTP/SSH), so a resumed prune or an out-of-band removal does not raise a
  // false "possible orphan" warning for data that is already gone.
  it('should treat deleting an already-absent shard as success (idempotent)', async () => {
    await expect(provider.delete({ provider_id: 'test-local', path: 'nonexistent.bfs.1' })).resolves.toBeUndefined();
  });

  // --- healthCheck ----------------------------------------------------------

  it('should return true for an existing path', async () => {
    expect(await provider.healthCheck()).toBe(true);
  });

  it('should return false for a non-existent path', async () => {
    const { io } = createMockProviderIO();
    const badProvider = new LocalFsProvider(makeConfig('/nonexistent/path/xyz'), io);
    expect(await badProvider.healthCheck()).toBe(false);
  });

  // --- authenticate ---------------------------------------------------------

  it('should succeed silently when path already exists', async () => {
    await expect(provider.authenticate()).resolves.toBeUndefined();
  });

  it('should create directory when confirm=true and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'new-subdir');
    const { io } = createMockProviderIO({ [`Path "${newPath}" does not exist. Create it?`]: 'true' });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await p.authenticate();
    const stat = await fs.stat(newPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('should throw when confirm=false and path does not exist', async () => {
    const newPath = path.join(tmpDir, 'refused-dir');
    const { io } = createMockProviderIO({ [`Path "${newPath}" does not exist. Create it?`]: 'false' });
    const p = new LocalFsProvider(makeConfig(newPath), io);
    await expect(p.authenticate()).rejects.toThrow(ProviderError);
  });

  // Non-interactive (--ci / no TTY): a missing base path must be
  // created without prompting. A prompt has nobody to answer, so asking would
  // abort a scripted repair/recovery that restores to a machine where the
  // source paths don't exist. The mock has NO confirm answer, so if the create
  // prompt were still reached it would resolve false and this would reject -
  // resolving proves the prompt was bypassed.
  it('should create the path without prompting when io is non-interactive', async () => {
    const newPath = path.join(tmpDir, 'ci-created-dir');
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const p = new LocalFsProvider(makeConfig(newPath), io);

    await expect(p.authenticate()).resolves.toBeUndefined();

    const stat = await fs.stat(newPath);
    expect(stat.isDirectory()).toBe(true);
  });

  // --- rename ---------------------------------------------------------------

  it('should rename a file and make it available under the new name', async () => {
    const tmpBuf = Buffer.from('payload');
    const ref = await uploadBuf(provider, 'shard_0.bfs.1.tmp', tmpBuf);
    const newRef = await provider.rename(ref, 'shard_0.bfs.1');
    expect(newRef.path).toBe('shard_0.bfs.1');

    const downloaded = await downloadBuf(provider, newRef);
    expect(downloaded).toEqual(Buffer.from('payload'));

    const refs = await provider.list();
    const names = refs.map((r) => r.path);
    expect(names).not.toContain('shard_0.bfs.1.tmp');
    expect(names).toContain('shard_0.bfs.1');
  });

  // --- updateShardHeader ----------------------------------------------------

  it('should update shard header, keep payload intact, and recompute trailing checksum', async () => {
    const payload = Buffer.alloc(256, 0xab);
    const originalHeader = makeHeader({ shard_index: 0 });
    const originalShard = buildShard(originalHeader, payload);

    const ref = await uploadBuf(provider, 'shard_0.bfs.1', originalShard);

    // Build a new header with updated location info (simulating a heal operation)
    const updatedHeader = makeHeader({ shard_index: 0, location_map: [{ ...TEST_LOCATIONS[0], remote_path: '/new/path/shard_0.bfs.1', shard_hash: 'c'.repeat(64) }] });
    const newShardForHeader = buildShard(updatedHeader, Buffer.alloc(0));
    // Extract just the header bytes (everything before the payload+checksum)
    // We built a shard with empty payload so: [header][0 payload][32 checksum]
    // -> header = newShardForHeader.subarray(0, length - 32)
    const newHeaderData = newShardForHeader.subarray(0, newShardForHeader.length - 32);

    await provider.updateShardHeader(ref, newHeaderData);

    const updatedBuf = await downloadBuf(provider, ref);

    // Should parse without error (checksum must be valid)
    const { header: h, payloadStream } = await parseShardHeaderFromStream(Readable.from(updatedBuf));
    const p = await streamToBuffer(payloadStream);

    // Payload must be untouched
    expect(p).toEqual(payload);

    // Header must reflect the update
    expect(h.location_map[0].remote_path).toBe('/new/path/shard_0.bfs.1');
  });

  // --- listVaults -----------------------------------------------------------

  it('should list vault directories under basePath', async () => {
    await fs.mkdir(path.join(tmpDir, 'vault-a'));
    await fs.mkdir(path.join(tmpDir, 'vault-b'));
    // Also place a regular file - must be excluded
    await fs.writeFile(path.join(tmpDir, 'not-a-vault.txt'), 'x');

    const { io } = createMockProviderIO();
    const p = new LocalFsProvider(makeConfig(tmpDir), io);
    const vaults = await p.listVaults();
    expect(vaults.sort()).toEqual(['vault-a', 'vault-b']);
  });

  it('should return empty array when basePath does not exist', async () => {
    const { io } = createMockProviderIO();
    const p = new LocalFsProvider(makeConfig('/nonexistent/xyz'), io);
    expect(await p.listVaults()).toEqual([]);
  });

  // --- getSize --------------------------------------------------------------

  describe('getSize', () => {
    it('should return the byte size of an existing shard via fs.stat', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      const data = Buffer.alloc(1024, 0x42);
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const size = await p.getSize({ provider_id: 'test-local', path: 'shard_0.bfs.1' });

      expect(size).toBe(1024);
    });

    it('should throw ProviderError when the shard is missing', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.getSize({ provider_id: 'test-local', path: 'shard_missing.bfs.1' })).rejects.toThrow(ProviderError);
    });
  });

  // --- downloadHeader -------------------------------------------------------

  describe('downloadHeader', () => {
    it('should return exactly maxBytes for a shard larger than the limit', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      // 100 KB shard, ask for 1 KB.
      const data = Buffer.alloc(100 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const head = await p.downloadHeader({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, 1024);

      expect(head.length).toBe(1024);
      expect(Buffer.compare(head, data.subarray(0, 1024))).toBe(0);
    });

    it('should return the entire file when maxBytes exceeds file size', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');
      const data = Buffer.from('short');
      await uploadBuf(p, 'shard_0.bfs.1', data);

      const head = await p.downloadHeader({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, 1_000_000);

      expect(head.length).toBe(5);
      expect(head.toString()).toBe('short');
    });

    it('should throw ProviderError for missing shard', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.downloadHeader({ provider_id: 'test-local', path: 'missing.bfs.1' }, 1024)).rejects.toThrow(ProviderError);
    });

    it('should reject maxBytes <= 0', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider(makeConfig(tmpDir), io);
      p.setVaultName('vault-1');

      await expect(p.downloadHeader({ provider_id: 'test-local', path: 'x' }, 0)).rejects.toThrow(ProviderError);
    });
  });

  // --- configureInteractive -------------------------------------------------

  describe('configureInteractive', () => {
    it('should ask for base path and return config', async () => {
      const { io } = createMockProviderIO({ 'Base directory path:': tmpDir });
      const { io: ctorIO } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractive(io);

      expect(config).toEqual({ path: tmpDir });
    });

    // The reason a path is refused decides what the operator types next, so the
    // warning must describe the path as it is. "Does not exist" sends them off to
    // create a directory - impossible under a file, and beside the point when the
    // path could not be inspected at all (whether it exists is then unknown).
    it('should name the file standing in the way when the path runs through a file', async () => {
      // Two levels below the file, so the parent of the typed path is not the
      // file itself: naming `dirname(typed)` would name `<file>/sub`.
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const script = scriptedIO([path.join(filePath, 'sub', 'deeper'), tmpDir]);
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractive(script.io);

      expect(config).toEqual({ path: tmpDir });
      expect(warningNamingOnly(script.warns, filePath)).toContain(filePath);
      expect(script.warns[0]).not.toContain('does not exist');
    });

    it.each(['EACCES', 'EPERM', 'ELOOP'])('should report a path it cannot inspect (%s) with the reason, not as missing', async (code) => {
      // The code is forced rather than provoked: a permission wall that
      // reproduces on Windows, Linux and macOS alike - and under a root account -
      // cannot be built from the filesystem.
      const denied = path.join(tmpDir, 'walled-off');
      vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
        if (String(target) === denied) throw Object.assign(new Error(`${code}: operation not permitted`), { code });
        return { isDirectory: () => true } as never;
      });
      const script = scriptedIO([denied, tmpDir]);
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractive(script.io);

      expect(config).toEqual({ path: tmpDir });
      expect(script.warns).toHaveLength(1);
      expect(script.warns[0]).toContain(denied);
      expect(script.warns[0]).toContain(code);
      expect(script.warns[0]).not.toContain('does not exist');
    });

    // POSIX kernels resolve `..` after following a link, `path.resolve` folds it
    // textually; Windows folds it textually too, so there both agree. A path the
    // kernel finds must be accepted, whatever its textual reading says.
    it.skipIf(process.platform === 'win32')('should accept a directory reached through `..` behind a link', async () => {
      await fs.mkdir(path.join(tmpDir, 'real', 'inner'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'real', 'data'));
      await fs.mkdir(path.join(tmpDir, 'nest'));
      await fs.symlink(path.join(tmpDir, 'real', 'inner'), path.join(tmpDir, 'nest', 'link'), 'dir');
      const typed = `${path.join(tmpDir, 'nest', 'link')}/../data`;
      const script = scriptedIO([typed]);
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractive(script.io);

      expect(config).toEqual({ path: typed });
      expect(script.warns).toEqual([]);
    });

    it('should keep reporting a path with nothing in its way as missing', async () => {
      const missing = path.join(tmpDir, 'not-there', 'deeper');
      const script = scriptedIO([missing, tmpDir]);
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractive(script.io);

      expect(config).toEqual({ path: tmpDir });
      expect(script.warns).toEqual([`Directory does not exist: ${missing}`]);
    });
  });

  // --- configureInteractiveForEdit ------------------------------------------
  //
  // `bfs provider edit` exists for the moment the medium is NOT there: the drive
  // was unplugged, the share moved, the mount point changed between machines.
  // The add-time flow re-prompts until the directory exists, which is right when
  // a backup is being created and wrong when its address is being corrected -
  // the operator would have nothing to type. The edit-aware flow therefore lets
  // a path that is not there yet be stored, once the operator stands behind it.
  describe('configureInteractiveForEdit', () => {
    it('should store a path that does not exist yet, once the operator confirms it', async () => {
      const missing = path.join(tmpDir, 'not-mounted-yet');
      const { io: base } = createMockProviderIO({ 'Base directory path:': missing });
      let confirms = 0;
      const io: ProviderIO = {
        ...base,
        async confirm(): Promise<boolean> {
          confirms += 1;
          return true;
        },
      };
      const { io: ctorIO } = createMockProviderIO();
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, ctorIO);
      expect(typeof p.configureInteractiveForEdit).toBe('function');

      const config = await p.configureInteractiveForEdit?.(io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: missing });
      expect(confirms).toBe(1);
    });

    it('should keep re-asking when the path cannot be reached at all, rather than offering it for confirmation', async () => {
      // EACCES is forced rather than provoked: a permission wall that reproduces
      // on Windows, Linux and macOS alike cannot be built from the filesystem.
      const denied = path.join(tmpDir, 'walled-off');
      const replies = [denied, tmpDir];
      let asked = 0;
      let confirms = 0;
      vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
        if (String(target) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return { isDirectory: () => true } as never;
      });
      const { io: base } = createMockProviderIO();
      const io: ProviderIO = {
        ...base,
        async ask(): Promise<string> {
          const reply = replies[asked] ?? tmpDir;
          asked += 1;
          return reply;
        },
        async confirm(): Promise<boolean> {
          confirms += 1;
          return true;
        },
      };
      const { io: ctorIO } = createMockProviderIO();
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, ctorIO);

      const config = await p.configureInteractiveForEdit?.(io, { existingConfig: { path: tmpDir } });

      // An unusable path is not something the operator can stand behind, so it is
      // re-asked - the confirmation belongs to "not there yet", not "not allowed".
      expect(config).toEqual({ path: tmpDir });
      expect(asked).toBe(2);
      expect(confirms).toBe(0);
    });

    it('should keep rejecting a path that exists but is not a directory', async () => {
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const replies = [filePath, tmpDir];
      let asked = 0;
      let confirms = 0;
      const { io: base } = createMockProviderIO();
      const io: ProviderIO = {
        ...base,
        async ask(): Promise<string> {
          const reply = replies[asked] ?? tmpDir;
          asked += 1;
          return reply;
        },
        async confirm(): Promise<boolean> {
          confirms += 1;
          return true;
        },
      };
      const { io: ctorIO } = createMockProviderIO();
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, ctorIO);
      expect(typeof p.configureInteractiveForEdit).toBe('function');

      const config = await p.configureInteractiveForEdit?.(io, { existingConfig: { path: tmpDir } });

      // A file where a directory belongs is a typo, not an absent medium - it is
      // re-asked, and nothing about it is put to the operator for confirmation.
      expect(config).toEqual({ path: tmpDir });
      expect(asked).toBe(2);
      expect(confirms).toBe(0);
    });

    // A path running through a file can never become a directory, so it is the
    // same typo as the file itself - whatever error code the platform reports for
    // it. Linux answers ENOTDIR, Windows answers ENOENT, and this test runs on the
    // real filesystem of both: deciding on the code alone offers the Windows
    // operator an unusable path for confirmation.
    it('should re-ask, without offering it for confirmation, a path that runs through a file', async () => {
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const script = scriptedIO([path.join(filePath, 'sub', 'deeper'), tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.asked()).toBe(2);
      expect(script.confirms()).toBe(0);
      expect(warningNamingOnly(script.warns, filePath)).toContain(filePath);
      expect(script.warns[0]).not.toContain('does not exist');
    });

    it('should treat a file typed with a trailing separator as the file itself', async () => {
      // Windows stats `file\` as the file itself; Linux answers ENOTDIR for
      // `file/`. Both are the file, so both get the answer the bare file gets -
      // not "missing", and not a parent named as the obstacle.
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const script = scriptedIO([filePath + path.sep, tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.confirms()).toBe(0);
      expect(script.warns).toEqual(['Path is not a directory']);
    });

    // Controls for the walk above a missing path. Only a FILE on the way makes a
    // path unusable; everything below is a medium that is not there yet - the
    // very case `provider edit` exists for - and must still reach confirmation.
    it('should offer a path nested under a missing directory for confirmation', async () => {
      const missing = path.join(tmpDir, 'not-mounted', 'backups');
      const script = scriptedIO([missing]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: missing });
      expect(script.confirms()).toBe(1);
      expect(script.warns).toEqual([]);
    });

    it('should offer a path for confirmation when nothing on its way exists, down to the root', async () => {
      // An unmapped drive letter or an offline share: not even the root answers.
      // Forced, because no root is missing on the machine running the test.
      const unmapped = path.join(tmpDir, 'offline-share', 'backups');
      const statSpy = vi.spyOn(fs, 'stat').mockRejectedValue(Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
      const script = scriptedIO([unmapped]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: unmapped });
      expect(script.confirms()).toBe(1);
      // The walk asked `fs.stat` about a directory above the real `tmpDir`, so
      // the answer came from the forced "nothing exists" - not from another call
      // finding a real directory on the way. This guards the control against a
      // vacuous pass; the defect itself is pinned by the tests above.
      const asked = statSpy.mock.calls.map(([target]) => path.resolve(String(target)));
      expect(asked).toContain(path.dirname(tmpDir));
    });

    it('should name the file, not the path below it, when the platform answers ENOTDIR', async () => {
      // Forced so the Linux answer is exercised on every platform: deciding by
      // error code (ENOTDIR -> name the parent) would otherwise pass wherever
      // the platform answers ENOENT for a path under a file.
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const realStat = fs.stat.bind(fs);
      vi.spyOn(fs, 'stat').mockImplementation(async (target, ...rest) => {
        if (path.resolve(String(target)).startsWith(filePath + path.sep)) throw Object.assign(new Error('ENOTDIR: not a directory'), { code: 'ENOTDIR' });
        return realStat(target, ...rest) as never;
      });
      const script = scriptedIO([path.join(filePath, 'sub', 'deeper'), tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.confirms()).toBe(0);
      expect(warningNamingOnly(script.warns, filePath)).toContain(filePath);
    });

    it('should offer a path for confirmation when it runs through a link to a missing target', async () => {
      // A mount point kept as a link to a drive that is unplugged. A junction is
      // used because Windows creates one without elevated rights.
      const mount = path.join(tmpDir, 'usb');
      await fs.symlink(path.join(tmpDir, 'unplugged-drive'), mount, 'junction');
      const typed = path.join(mount, 'backups');
      const script = scriptedIO([typed]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: typed });
      expect(script.confirms()).toBe(1);
      expect(script.warns).toEqual([]);
    });

    it('should name the ancestor it could not check, not offer the path for confirmation', async () => {
      // The typed path is absent, but an entry above it refuses inspection - a
      // folder in another user's profile on Windows, which has no traversal
      // check. Whether a file stands there is unknown, so the path is refused,
      // naming where the check failed. Forced: no portable permission wall.
      const walled = path.join(tmpDir, 'walled');
      const typed = path.join(walled, 'backups');
      vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
        const resolved = path.resolve(String(target));
        if (resolved === typed) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        if (resolved === walled) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return { isDirectory: () => true } as never;
      });
      const script = scriptedIO([typed, tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.confirms()).toBe(0);
      expect(script.warns).toEqual([`Cannot check directory ${walled} (EPERM)`]);
    });

    it.skipIf(process.platform === 'win32')('should not offer for confirmation a path the kernel found a file on, even when `..` hides it textually', async () => {
      // `file/../backups` folds to `<tmp>/backups` textually, while the kernel
      // answers ENOTDIR because it walks through the file first. No directory
      // can be created there, so "not there yet" must not be claimed.
      const filePath = path.join(tmpDir, 'a-file.txt');
      await fs.writeFile(filePath, 'x', 'utf8');
      const script = scriptedIO([`${filePath}/../backups`, tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.confirms()).toBe(0);
      expect(script.warns).toHaveLength(1);
      expect(script.warns[0]).toContain('ENOTDIR');
    });

    it('should offer a missing relative path for confirmation', async () => {
      const relative = path.join('bfs-not-mounted-relative', 'backups');
      const script = scriptedIO([relative]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: relative });
      expect(script.confirms()).toBe(1);
    });

    it.each(['EACCES', 'EPERM', 'ELOOP'])('should report a path it cannot inspect (%s) with the reason, not as missing', async (code) => {
      // Forced for the same reason as in the add flow: no portable permission wall.
      const denied = path.join(tmpDir, 'walled-off');
      vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
        if (String(target) === denied) throw Object.assign(new Error(`${code}: operation not permitted`), { code });
        return { isDirectory: () => true } as never;
      });
      const script = scriptedIO([denied, tmpDir]);
      const p: StorageProvider = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, createMockProviderIO().io);

      const config = await p.configureInteractiveForEdit?.(script.io, { existingConfig: { path: tmpDir } });

      expect(config).toEqual({ path: tmpDir });
      expect(script.confirms()).toBe(0);
      expect(script.warns).toHaveLength(1);
      expect(script.warns[0]).toContain(denied);
      expect(script.warns[0]).toContain(code);
      expect(script.warns[0]).not.toContain('does not exist');
    });
  });

  // --- configureFromFlags ---------------------------------------------------

  describe('configureFromFlags', () => {
    it('should default to ~/.bfs-local/<name> when filePath is null', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'my-backup' }));

      expect(config.path).toBe(path.join(os.homedir(), '.bfs-local', 'my-backup'));
    });

    it('should read JSON file containing { path } when filePath is given', async () => {
      const file = await writeConfigFile(JSON.stringify({ path: '/custom/path' }));

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }));

      expect(config).toEqual({ path: '/custom/path' });
    });

    it('should throw ProviderError when JSON lacks a non-empty "path"', async () => {
      const file = await writeConfigFile(JSON.stringify({ path: '' }));

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
      // Regression: error must mention the missing "path" field clearly so
      // user knows the JSON shape, not the unrelated init-level flag layout.
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(/non-empty "path"/);
    });

    it('should throw on malformed JSON', async () => {
      const file = await writeConfigFile('not json');

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    it('should throw when JSON is not a plain object', async () => {
      const file = await writeConfigFile(JSON.stringify([1, 2]));

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      await expect(p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--config-file', file] }))).rejects.toThrow(ProviderError);
    });

    // --- Inline --path ------------------------------------------------------

    it('should accept inline --path with absolute path', async () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', '/abs/custom'] }));

      expect(config).toEqual({ path: '/abs/custom' });
    });

    it('should resolve a relative --path against io.workDir', async () => {
      const { io } = createMockProviderIO({}, '/work');
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', './rel'] }));

      expect(config).toEqual({ path: path.resolve('/work', './rel') });
    });

    it('should let inline --path win over --config-file', async () => {
      const file = await writeConfigFile(JSON.stringify({ path: '/from/json' }));

      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const config = await p.configureFromFlags(cliInput({ name: 'x', rawArgs: ['--path', '/from/inline', '--config-file', file] }));

      expect(config).toEqual({ path: '/from/inline' });
    });
  });

  // --- validateConfig -------------------------------------------------------

  describe('validateConfig', () => {
    it('should return [] for a non-empty path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      expect(p.validateConfig({ path: tmpDir })).toEqual([]);
    });

    it('should report missing path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({});
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => /path/i.test(e))).toBe(true);
    });

    it('should report empty-string path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const errors = p.validateConfig({ path: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // --- describeConfig -------------------------------------------------------

  describe('describeConfig', () => {
    it('should include the path', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);

      const desc = p.describeConfig({ path: '/my/backup' });

      expect(desc).toContain('/my/backup');
    });
  });

  // --- getSecretFields ------------------------------------------------------

  describe('getSecretFields', () => {
    it('should return []', () => {
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'stub', type: 'local', adapterPackage: null, config: {} }, io);
      expect(p.getSecretFields()).toEqual([]);
    });
  });

  // --- probeConnection ------------------------------------------------------

  describe('probeConnection', () => {
    it('should write/read/compare/unlink - leaving no residue in vault dir', async () => {
      await provider.probeConnection();

      const refs = await provider.list();
      expect(refs).toEqual([]);
    });

    it('should throw ProviderError when basePath is unwritable', async () => {
      const badPath = path.join(os.tmpdir(), `bfs-unwritable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      // NOTE: path simply does not exist and its parent is writable -
      // but probeConnection tries to create vaultDir under a non-existent
      // root; on Windows this surfaces as EACCES/ENOENT. On Linux it may
      // succeed via recursive mkdir. To force failure, use a path under a
      // non-existent root whose parent chain includes an invalid segment.
      const { io } = createMockProviderIO();
      const p = new LocalFsProvider({ id: 'x', type: 'local', adapterPackage: null, config: { path: path.join(badPath, 'nope') } }, io);
      p.setVaultName('testvault');

      // Create a FILE at badPath so mkdir underneath it fails with ENOTDIR
      await fs.writeFile(badPath, 'blocker');
      try {
        await expect(p.probeConnection()).rejects.toThrow(ProviderError);
      } finally {
        await fs.rm(badPath, { force: true });
      }
    });
  });

  // --- usesSidecar / verifyShard / sidecar methods ---------------------------

  describe('header storage strategy + verifyShard', () => {
    const IDENTITY = { vault_id: '550e8400-e29b-41d4-a716-446655440000', shard_index: 0, version: 1 };

    it('should return ok for a matching shard identity', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader(), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result).toEqual({ ok: true });
    });

    it('should report not_found for a missing shard', async () => {
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.999' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_found');
    });

    // Regression: a present-but-unreadable shard must classify as unverifiable,
    // not not_found. A directory at the shard path is readable (fs.access R_OK
    // passes) but reads as EISDIR - the cause must drive the classification, so
    // a non-ENOENT failure stays unverifiable without a second stat.
    it('should report unverifiable when the shard path is present but unreadable', async () => {
      await uploadBuf(provider, 'shard_keep.bfs.1', Buffer.from('seed')); // creates the vault dir
      await fs.mkdir(path.join(tmpDir, 'testvault', 'shard_0.bfs.1'), { recursive: true });

      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unverifiable');
    });

    it('should report mismatch on a wrong expected version', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', buildShard(makeHeader({ version: 1 }), Buffer.from('payload')));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, { ...IDENTITY, version: 5 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('mismatch');
        expect(result.detail).toContain('version');
      }
    });

    it('should report corrupted for a truncated shard', async () => {
      await uploadBuf(provider, 'shard_0.bfs.1', Buffer.alloc(8));
      const result = await provider.verifyShard({ provider_id: 'test-local', path: 'shard_0.bfs.1' }, IDENTITY);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('corrupted');
    });
  });

  // --- vault name runtime guard (path traversal) ------------------------------
  // A vault name becomes a path segment under basePath ({basePath}/{vaultName}/
  // shard_...). With no guard the name escapes the root for real: list() reads
  // the parent directory, and upload() (recursive mkdir + write) lands the shard
  // outside the configured base. The provider must refuse it where the path is
  // built (vaultDir()). The safe-segment rule is a BFS-core invariant, so it
  // throws the core UnsafePathError - the same type the unpack-path traversal
  // guard (resolveSafeChildPath) raises - not a provider-specific ProviderError.
  // Scope is separators / '..' only; control chars / NUL are a transport concern
  // (covered in ftp.test.ts) and stay out of this filesystem-segment floor.
  //
  // Each case points the base path one level below a throwaway temp root, so the
  // escape resolves *inside* that root: the RED is a genuine escape (not an
  // incidental OS error) and nothing is left behind on disk.
  describe('vault name runtime guard', () => {
    async function withBase(run: (base: string) => Promise<void>): Promise<void> {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-lf-trav-'));
      const base = path.join(root, 'base');
      await fs.mkdir(base);
      try {
        await run(base);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }

    // upload() recursively creates the resolved directory and writes the shard
    // there, so today the write SUCCEEDS at an escaping / separator-injected path
    // - exactly the vulnerability. The guard must reject before the write.
    const ESCAPING_NAMES: ReadonlyArray<[label: string, name: string]> = [
      ['bare dot-dot (escapes to parent)', '..'],
      ['parent-traversal prefix', '../evil'],
      ['forward-slash separator', 'a/b'],
      ['backslash separator', 'a\\b'],
    ];

    for (const [label, name] of ESCAPING_NAMES) {
      it(`should reject upload() for a vault name with ${label}`, async () => {
        await withBase(async (base) => {
          const { io } = createMockProviderIO();
          const p = new LocalFsProvider(makeConfig(base), io);
          p.setVaultName(name);

          await expect(uploadBuf(p, 'shard_0.bfs.1', Buffer.from('x'))).rejects.toThrow(UnsafePathError);
        });
      });
    }

    // Concrete read-escape demonstration: with '..', list() resolves base/.. =
    // the parent directory and returns its contents today. The guard must turn
    // that into UnsafePathError.
    it('should reject list() for a vault name that escapes to the parent dir', async () => {
      await withBase(async (base) => {
        const { io } = createMockProviderIO();
        const p = new LocalFsProvider(makeConfig(base), io);
        p.setVaultName('..');

        await expect(p.list()).rejects.toThrow(UnsafePathError);
      });
    });

    // Control case - proves the guard is not overly broad: a normal name still
    // works end-to-end (list returns, upload succeeds).
    it('should accept a normal vault name (no false positive)', async () => {
      await withBase(async (base) => {
        const { io } = createMockProviderIO();
        const p = new LocalFsProvider(makeConfig(base), io);
        p.setVaultName('my-backup');

        await expect(p.list()).resolves.toEqual([]);
        const ref = await uploadBuf(p, 'shard_0.bfs.1', Buffer.from('payload'));
        expect(ref.path).toBe('shard_0.bfs.1');
      });
    });
  });
});

// Header sidecar (BFSH): LocalFS keeps a relocated shard's updated header in a
// small `hdr_i.bfs.V` file next to the shard instead of rewriting the whole
// shard, so a `bfs repair` location change transfers KB, not the full payload.
// The sidecar name uses an `hdr_` prefix (not a `.hdr` suffix) so a version
// parser scanning `shard_*` never mistakes it for a shard.
describe('LocalFsProvider - header sidecar (BFSH)', () => {
  let tmpDir: string;
  let provider: LocalFsProvider;
  const shardRef = { provider_id: 'test-local', path: 'shard_0.bfs.1' };
  const sidecarPath = (): string => path.join(tmpDir, 'testvault', 'hdr_0.bfs.1');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-sidecar-'));
    const { io } = createMockProviderIO();
    provider = new LocalFsProvider(makeConfig(tmpDir), io);
    provider.setVaultName('testvault');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should report usesSidecar() === true', () => {
    expect(provider.usesSidecar()).toBe(true);
  });

  it('should round-trip header bytes through uploadHeaderSidecar/downloadHeaderSidecar', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    const sidecar = Buffer.from('BFSH-header-bytes');

    await provider.uploadHeaderSidecar(shardRef, sidecar);
    const read = await provider.downloadHeaderSidecar(shardRef, 16384);

    expect(read).not.toBeNull();
    expect(Buffer.compare(read as Buffer, sidecar)).toBe(0);
  });

  it('should return null from downloadHeaderSidecar when no sidecar exists', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));

    await expect(provider.downloadHeaderSidecar(shardRef, 16384)).resolves.toBeNull();
  });

  it('should remove a stale sidecar when the shard is re-uploaded (reconcile)', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    await fs.writeFile(sidecarPath(), Buffer.from('stale-sidecar'));

    // A fresh shard carries a fresh in-shard header, so its old sidecar must go.
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload-v2'));

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  it('should remove the sidecar when the shard is deleted', async () => {
    await uploadBuf(provider, 'shard_0.bfs.1', Buffer.from('payload'));
    await fs.writeFile(sidecarPath(), Buffer.from('sidecar'));

    await provider.delete(shardRef);

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });

  // A resumed prune (the shard is already gone) must still clear an orphan
  // `hdr_` sidecar. Because delete() no longer throws on an absent shard,
  // sidecar removal is reached and the stale header does not survive.
  it('should remove an orphan sidecar even when the shard is already absent', async () => {
    await fs.mkdir(path.join(tmpDir, 'testvault'), { recursive: true });
    await fs.writeFile(sidecarPath(), Buffer.from('orphan-sidecar'));

    await provider.delete(shardRef);

    await expect(fs.access(sidecarPath())).rejects.toThrow();
  });
});
