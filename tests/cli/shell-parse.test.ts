import { describe, expect, it } from 'vitest';
import { shellParse } from '../../src/cli/shell-parse.js';
import { BfsError } from '../../src/core/errors.js';

describe('shellParse', () => {
  // ─── Plain whitespace splitting ──────────────────────────────────────────

  it('should split tokens on whitespace', () => {
    expect(shellParse('ftp:nas --config-file ./ftp.json')).toEqual([
      'ftp:nas',
      '--config-file',
      './ftp.json',
    ]);
  });

  it('should collapse runs of whitespace', () => {
    expect(shellParse('a   b\t\tc\nd')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should return empty array for empty input', () => {
    expect(shellParse('')).toEqual([]);
  });

  it('should return empty array for whitespace-only input', () => {
    expect(shellParse('   \t\n ')).toEqual([]);
  });

  // ─── Quoted strings ──────────────────────────────────────────────────────

  it('should preserve whitespace inside double quotes', () => {
    expect(shellParse('--path "C:/Program Files/bfs/ftp.json"')).toEqual([
      '--path',
      'C:/Program Files/bfs/ftp.json',
    ]);
  });

  it('should preserve whitespace inside single quotes', () => {
    expect(shellParse("--flag 'value with spaces'")).toEqual([
      '--flag',
      'value with spaces',
    ]);
  });

  it('should treat single quotes as literal (no escapes)', () => {
    expect(shellParse("'foo\\bar'")).toEqual(['foo\\bar']);
  });

  it('should join adjacent quoted and unquoted fragments into one token', () => {
    expect(shellParse('foo"bar baz"qux')).toEqual(['foobar bazqux']);
  });

  it('should handle a fully unquoted token after a quoted one', () => {
    expect(shellParse('"a b" c')).toEqual(['a b', 'c']);
  });

  // ─── Backslash handling ──────────────────────────────────────────────────

  it('should treat backslash as literal outside quotes', () => {
    // Anchors the rule that Windows paths inline (`--path D:\backup\p1`)
    // are tokenized verbatim — including the `\b` and `\v` sequences.
    expect(shellParse('--path D:\\backup\\p1')).toEqual([
      '--path',
      'D:\\backup\\p1',
    ]);
  });

  it('should keep backslash literal even before a space outside quotes', () => {
    // Backslash has no special meaning outside quotes — the space still
    // splits the input into two tokens. To preserve a space inside a
    // single value, use single or double quotes.
    expect(shellParse('path\\ split')).toEqual(['path\\', 'split']);
  });

  it('should only recognize \\" and \\\\ inside double quotes', () => {
    expect(shellParse('"say \\"hi\\""')).toEqual(['say "hi"']);
    expect(shellParse('"back\\\\slash"')).toEqual(['back\\slash']);
  });

  it('should keep unrecognized backslashes inside double quotes verbatim', () => {
    expect(shellParse('"a\\b"')).toEqual(['a\\b']);
  });

  // ─── Error surface ───────────────────────────────────────────────────────

  it('should throw BfsError on unclosed double quote', () => {
    expect(() => shellParse('foo "unterminated')).toThrow(BfsError);
  });

  it('should throw BfsError on unclosed single quote', () => {
    expect(() => shellParse("foo 'bar")).toThrow(BfsError);
  });

  // ─── Realistic provider spec ─────────────────────────────────────────────

  it('should tokenize a full pass-through provider spec', () => {
    const spec =
      "ftp:nas-prod --jakis-parametr 'wartosc ze spacja' " +
      "-inna_forma-propsa --config-file './katalog ze spacja/ftp.json'";
    expect(shellParse(spec)).toEqual([
      'ftp:nas-prod',
      '--jakis-parametr',
      'wartosc ze spacja',
      '-inna_forma-propsa',
      '--config-file',
      './katalog ze spacja/ftp.json',
    ]);
  });

  it('should tokenize a colon-rich token as a single token', () => {
    // Colons have no special meaning in shellParse — `local:usb1:/mnt/usb`
    // is one literal token. The provider-spec dispatcher splits on the
    // first colon afterwards, but the tokenizer itself does not.
    expect(shellParse('local:usb1:/mnt/usb')).toEqual(['local:usb1:/mnt/usb']);
  });

  it('should tokenize a Windows-path inline provider spec', () => {
    // Provider spec with a Windows base path. cmd / PowerShell strip the
    // outer quotes before shellParse sees the value; the inner string
    // must tokenize cleanly without mangling backslashes.
    expect(shellParse('local:vol1 --path D:\\backup\\vol1')).toEqual([
      'local:vol1',
      '--path',
      'D:\\backup\\vol1',
    ]);
  });
});
