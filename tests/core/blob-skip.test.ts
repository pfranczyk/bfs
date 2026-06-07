/**
 * Tests for packBlob / unpackBlob skip-on-error behavior.
 * These live in a separate file because vi.mock() at module scope is required
 * to intercept ESM named exports from node:fs/promises.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted by Vitest so it runs before all imports.
// We wrap readFile and writeFile with vi.fn() so tests can override them selectively.
// The default implementation calls through to the real functions.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, readFile: vi.fn(real.readFile), writeFile: vi.fn(real.writeFile) };
});

// These imports must come AFTER vi.mock so they receive the mocked module.
import { packBlob } from '../../src/core/blob-pack.js';
import { parseBlobFileTable, unpackBlob } from '../../src/core/blob-unpack.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';

describe('blob-pack / blob-unpack — skip behavior', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(async () => {
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-skip-'));
    outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-skip-'));
  });

  afterEach(async () => {
    // Restore default (call-through) implementations after each test
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.readFile).mockImplementation(real.readFile as typeof fs.readFile);
    vi.mocked(fs.writeFile).mockImplementation(real.writeFile as typeof fs.writeFile);
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('should skip files that cannot be read during pack', async () => {
    const goodPath = path.join(srcDir, 'good.txt');
    const badPath = path.join(srcDir, 'bad.txt');
    await fs.writeFile(goodPath, 'ok content');
    await fs.writeFile(badPath, 'restricted');

    const filter = await createIgnoreFilter(srcDir);

    // Override readFile: fail for bad.txt, pass through for everything else
    const realReadFile = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((m) => m.readFile);

    vi.mocked(fs.readFile).mockImplementation(async (p: Parameters<typeof fs.readFile>[0], ...rest) => {
      if (String(p).endsWith('bad.txt')) {
        throw new Error('EACCES: permission denied, open bad.txt');
      }
      return realReadFile(p, ...(rest as []));
    });

    const { blob, skipped } = await packBlob(srcDir, filter);

    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toBe('bad.txt');
    expect(skipped[0].reason).toContain('EACCES');

    const entries = parseBlobFileTable(blob);
    expect(entries.map((e) => e.path)).toContain('good.txt');
    expect(entries.map((e) => e.path)).not.toContain('bad.txt');
  });

  it('should skip files that cannot be written during unpack', async () => {
    await fs.writeFile(path.join(srcDir, 'good.txt'), 'good');
    await fs.writeFile(path.join(srcDir, 'bad.txt'), 'bad');

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);

    // Override writeFile: fail for bad.txt, pass through for everything else
    const realWriteFile = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((m) => m.writeFile);

    vi.mocked(fs.writeFile).mockImplementation(async (p: Parameters<typeof fs.writeFile>[0], data, options?) => {
      if (String(p).endsWith('bad.txt')) {
        throw new Error('EACCES: permission denied, open bad.txt');
      }
      return realWriteFile(p, data as never, options as never);
    });

    const { extracted, skipped } = await unpackBlob(blob, outDir);

    expect(skipped).toHaveLength(1);
    expect(skipped[0].path).toBe('bad.txt');
    expect(skipped[0].reason).toContain('EACCES');
    expect(extracted).toHaveLength(1);
    expect(extracted[0].path).toBe('good.txt');
  });
});
