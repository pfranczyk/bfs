import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendToBfsignore, createIgnoreFilter } from '../../src/core/ignore.js';

function makeTmpDir(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfs-test-'));
  if (content !== undefined) {
    writeFileSync(join(dir, '.bfsignore'), content, 'utf-8');
  }
  return dir;
}

describe('createIgnoreFilter - .bfs/ always ignored', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('should always ignore .bfs/ even without .bfsignore', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('.bfs/config.json')).toBe(true);
    expect(filter('.bfs/state.json')).toBe(true);
  });

  it('should not ignore regular files when no .bfsignore', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('readme.txt')).toBe(false);
    expect(filter('src/main.ts')).toBe(false);
  });
});

describe('createIgnoreFilter - pattern matching', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir('*.log\nbuild/\n*.tmp');
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('should ignore files matching wildcard pattern', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('error.log')).toBe(true);
    expect(filter('debug.log')).toBe(true);
    expect(filter('cache.tmp')).toBe(true);
  });

  it('should ignore files inside ignored directory', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('build/output.js')).toBe(true);
    expect(filter('build/index.html')).toBe(true);
  });

  it('should not ignore files not matching any pattern', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('src/index.ts')).toBe(false);
    expect(filter('readme.md')).toBe(false);
  });
});

describe('createIgnoreFilter - negation', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir('*.log\n!important.log');
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('should not ignore file explicitly negated', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('important.log')).toBe(false);
  });

  it('should still ignore other files matching the pattern', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('debug.log')).toBe(true);
    expect(filter('error.log')).toBe(true);
  });
});

describe('createIgnoreFilter - comments', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir('# this is a comment\n*.log\n# another comment\n*.tmp');
  });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('should treat # lines as comments and not as patterns', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('# this is a comment')).toBe(false);
  });

  it('should still apply non-comment patterns', () => {
    const filter = createIgnoreFilter(dir);
    expect(filter('error.log')).toBe(true);
    expect(filter('cache.tmp')).toBe(true);
  });
});

describe('createIgnoreFilter - no .bfsignore file', () => {
  it('should not throw when .bfsignore does not exist', () => {
    const dir = makeTmpDir(); // no .bfsignore written
    expect(() => createIgnoreFilter(dir)).not.toThrow();
    rmSync(dir, { recursive: true });
  });
});

describe('appendToBfsignore', () => {
  let dir: string;

  afterEach(() => rmSync(dir, { recursive: true }));

  it('should append anchored patterns that the ignore filter then excludes', async () => {
    dir = makeTmpDir('*.log\n');

    await appendToBfsignore(dir, ['nested/link.txt', 'top.sock']);

    const filter = createIgnoreFilter(dir);
    expect(filter('nested/link.txt')).toBe(true);
    expect(filter('top.sock')).toBe(true);
    // Anchored to root: a same-named file in a different directory is untouched.
    expect(filter('other/top.sock')).toBe(false);
    // Pre-existing patterns still apply.
    expect(filter('error.log')).toBe(true);
  });

  it('should create .bfsignore when it does not exist', async () => {
    dir = makeTmpDir(); // no .bfsignore

    await appendToBfsignore(dir, ['weird.txt']);

    const filter = createIgnoreFilter(dir);
    expect(filter('weird.txt')).toBe(true);
  });

  it('should escape gitignore metacharacters so literal names match exactly', async () => {
    dir = makeTmpDir();

    // A leading '#' would be a comment, '!' a negation, '[' '*' '?' globs - all
    // must be escaped so the exact file name is what gets ignored.
    await appendToBfsignore(dir, ['#hash.txt', '!bang.txt', 'a[1].txt', 'star*.txt']);

    const filter = createIgnoreFilter(dir);
    expect(filter('#hash.txt')).toBe(true);
    expect(filter('!bang.txt')).toBe(true);
    expect(filter('a[1].txt')).toBe(true);
    expect(filter('star*.txt')).toBe(true);
    // The escaped '*' must be literal, not a wildcard.
    expect(filter('starXYZ.txt')).toBe(false);
  });

  it('should insert a separating newline when the file lacks a trailing one', async () => {
    dir = makeTmpDir('*.log'); // no trailing newline

    await appendToBfsignore(dir, ['link.txt']);

    const content = await readFile(join(dir, '.bfsignore'), 'utf-8');
    expect(content).toContain('*.log\n');
    const filter = createIgnoreFilter(dir);
    expect(filter('error.log')).toBe(true);
    expect(filter('link.txt')).toBe(true);
  });

  it('should be a no-op for an empty path list', async () => {
    dir = makeTmpDir('*.log\n');

    await appendToBfsignore(dir, []);

    const content = await readFile(join(dir, '.bfsignore'), 'utf-8');
    expect(content).toBe('*.log\n');
  });
});
