import { describe, expect, it } from 'vitest';
import { parseVersionRange } from '../../src/cli/parse-version-range.js';

describe('parseVersionRange', () => {
  const all = [1, 2, 3, 4, 5, 10, 15];

  it('should select a single existing version', () => {
    expect(parseVersionRange('3', all)).toEqual([3]);
  });

  it('should select an inclusive range', () => {
    expect(parseVersionRange('1-3', all)).toEqual([1, 2, 3]);
  });

  it('should select a comma-separated list', () => {
    expect(parseVersionRange('1,3,5', all)).toEqual([1, 3, 5]);
  });

  it('should select a mixed list of ranges and singles', () => {
    expect(parseVersionRange('1-3,10,15', all)).toEqual([1, 2, 3, 10, 15]);
  });

  it('should filter out non-existent versions in a range', () => {
    expect(parseVersionRange('3-12', all)).toEqual([3, 4, 5, 10]);
  });

  it('should deduplicate overlapping parts', () => {
    expect(parseVersionRange('1-3,2-4', all)).toEqual([1, 2, 3, 4]);
  });

  it('should return every existing version for "all" when keywords are allowed', () => {
    expect(parseVersionRange('all', all, { allowKeywords: true })).toEqual([1, 2, 3, 4, 5, 10, 15]);
  });

  it('should be case-insensitive for "all"', () => {
    expect(parseVersionRange('ALL', all, { allowKeywords: true })).toEqual([1, 2, 3, 4, 5, 10, 15]);
  });

  it('should return the highest existing version for "latest"', () => {
    expect(parseVersionRange('latest', all, { allowKeywords: true })).toEqual([15]);
  });

  it('should be case-insensitive for "latest"', () => {
    expect(parseVersionRange('Latest', all, { allowKeywords: true })).toEqual([15]);
  });

  it('should return empty for "latest" when no versions exist', () => {
    expect(parseVersionRange('latest', [], { allowKeywords: true })).toEqual([]);
  });

  it('should return empty for "all" when no versions exist', () => {
    expect(parseVersionRange('all', [], { allowKeywords: true })).toEqual([]);
  });

  it('should reject "all" when keywords are disabled (prune default)', () => {
    expect(() => parseVersionRange('all', all)).toThrow();
  });

  it('should reject "latest" when keywords are disabled (prune default)', () => {
    expect(() => parseVersionRange('latest', all)).toThrow();
  });

  it('should throw on inverted range (from > to)', () => {
    expect(() => parseVersionRange('5-1', all)).toThrow();
  });

  it('should throw on an unparseable token', () => {
    expect(() => parseVersionRange('abc', all)).toThrow();
  });

  it('should throw when one token in a list is invalid', () => {
    expect(() => parseVersionRange('1,xyz', all)).toThrow();
  });
});
