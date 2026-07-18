import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UnsafePathError } from '../../src/core/errors.js';
import { assertSafeFilename, isSafeFilename, resolveSafeChildPath } from '../../src/core/fs-utils.js';

describe('resolveSafeChildPath', () => {
  const root = path.join(os.tmpdir(), 'bfs-safe-root');

  it('should resolve a valid nested path inside root', () => {
    const resolved = resolveSafeChildPath(root, 'a/b/c.txt');

    expect(resolved).toBe(path.resolve(root, 'a', 'b', 'c.txt'));
  });

  it('should resolve a single file at the root', () => {
    const resolved = resolveSafeChildPath(root, 'file.txt');

    expect(resolved).toBe(path.resolve(root, 'file.txt'));
    expect(resolved.startsWith(path.resolve(root))).toBe(true);
  });

  it('should reject a leading ".." segment', () => {
    expect(() => resolveSafeChildPath(root, '../evil')).toThrow(UnsafePathError);
  });

  it('should reject a ".." segment buried mid-path', () => {
    expect(() => resolveSafeChildPath(root, 'a/../../evil')).toThrow(UnsafePathError);
  });

  it('should reject a ".." segment with a Windows separator', () => {
    expect(() => resolveSafeChildPath(root, '..\\evil')).toThrow(UnsafePathError);
  });

  it('should reject an absolute POSIX path', () => {
    expect(() => resolveSafeChildPath(root, '/etc/passwd')).toThrow(UnsafePathError);
  });

  it('should reject an absolute Windows path', () => {
    expect(() => resolveSafeChildPath(root, 'C:\\Windows\\system32\\drivers\\etc\\hosts')).toThrow(UnsafePathError);
  });

  it('should reject a UNC path', () => {
    expect(() => resolveSafeChildPath(root, '\\\\server\\share\\evil')).toThrow(UnsafePathError);
  });

  it('should reject a path containing a NUL byte', () => {
    expect(() => resolveSafeChildPath(root, 'a\0b')).toThrow(UnsafePathError);
  });

  it('should keep a deep but contained path inside root', () => {
    const resolved = resolveSafeChildPath(root, 'a/b/c/d/e/f.txt');

    expect(resolved.startsWith(path.resolve(root) + path.sep)).toBe(true);
  });
});

describe('assertSafeFilename / isSafeFilename', () => {
  it('should accept a normal shard / sidecar filename', () => {
    expect(() => assertSafeFilename('shard_0.bfs.1')).not.toThrow();
    expect(() => assertSafeFilename('hdr_12.bfs.37')).not.toThrow();
    expect(isSafeFilename('shard_0.bfs.1')).toBe(true);
  });

  it('should reject empties, separators, dot segments, and control characters', () => {
    for (const bad of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'a\r\nb', 'a\0b']) {
      expect(() => assertSafeFilename(bad)).toThrow(UnsafePathError);
      expect(isSafeFilename(bad)).toBe(false);
    }
  });
});
