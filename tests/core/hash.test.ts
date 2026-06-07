import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hashBuffer, hashStream } from '../../src/core/hash.js';

describe('hashBuffer', () => {
  it('should return correct SHA-256 for empty buffer', () => {
    const result = hashBuffer(Buffer.alloc(0));
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should return correct SHA-256 for known input', () => {
    const result = hashBuffer(Buffer.from('hello world', 'utf-8'));
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should return correct SHA-256 for "abc"', () => {
    const result = hashBuffer(Buffer.from('abc', 'utf-8'));
    expect(result).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('should return 64-character hex string', () => {
    const result = hashBuffer(Buffer.from('test'));
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});

describe('hashStream', () => {
  it('should return correct SHA-256 for stream with known content', async () => {
    const stream = Readable.from([Buffer.from('hello world', 'utf-8')]);
    const result = await hashStream(stream);
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should handle empty stream', async () => {
    const stream = Readable.from([]);
    const result = await hashStream(stream);
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should handle multi-chunk stream', async () => {
    const stream = Readable.from([Buffer.from('hello '), Buffer.from('world')]);
    const result = await hashStream(stream);
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('should reject on stream error', async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error('stream error'));
      },
    });
    await expect(hashStream(stream)).rejects.toThrow('stream error');
  });
});
