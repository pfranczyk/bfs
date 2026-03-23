import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIgnoreFilter } from '../../src/core/ignore.js';

function makeTmpDir(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bfs-test-'));
  if (content !== undefined) {
    writeFileSync(join(dir, '.bfsignore'), content, 'utf-8');
  }
  return dir;
}

describe('createIgnoreFilter — .bfs/ always ignored', () => {
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

describe('createIgnoreFilter — pattern matching', () => {
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

describe('createIgnoreFilter — negation', () => {
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

describe('createIgnoreFilter — comments', () => {
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

describe('createIgnoreFilter — no .bfsignore file', () => {
  it('should not throw when .bfsignore does not exist', () => {
    const dir = makeTmpDir(); // no .bfsignore written
    expect(() => createIgnoreFilter(dir)).not.toThrow();
    rmSync(dir, { recursive: true });
  });
});
