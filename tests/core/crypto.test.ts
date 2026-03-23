import { describe, expect, it } from 'vitest';
import {
  decryptBlob,
  decryptBlobWithKey,
  decryptLocationMap,
  deriveKey,
  encryptBlob,
  encryptLocationMap,
  generateSalt,
} from '../../src/core/crypto.js';
import { DecryptionError } from '../../src/core/errors.js';
import type { ShardLocation } from '../../src/types/index.js';

// Argon2id z parametrami produkcyjnymi (64 MiB) jest wolny — wyższy timeout.
const TIMEOUT = 30_000;

const SAMPLE_LOCATIONS: ShardLocation[] = [
  {
    shard_index: 0,
    provider_id: 'local-1',
    provider_type: 'local',
    connection_config: { path: '/backup' },
    remote_path: '/backup/vault/shard_0.bfs.1',
    shard_hash: 'abc123',
  },
  {
    shard_index: 1,
    provider_id: 'ftp-1',
    provider_type: 'ftp',
    connection_config: { host: '192.168.1.10', port: 21 },
    remote_path: '/backup/vault/shard_1.bfs.1',
    shard_hash: 'def456',
  },
];

describe('crypto', () => {
  describe('generateSalt', () => {
    it('should return a 16-byte Buffer', () => {
      const salt = generateSalt();
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(16);
    });

    it('should return different values on each call', () => {
      const s1 = generateSalt();
      const s2 = generateSalt();
      expect(s1.equals(s2)).toBe(false);
    });
  });

  describe('deriveKey', () => {
    it(
      'should derive a 32-byte key from password and salt',
      async () => {
        const salt = generateSalt();
        const key = await deriveKey('password', salt);
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
      },
      TIMEOUT,
    );

    it(
      'should produce the same key for the same password and salt',
      async () => {
        const salt = generateSalt();
        const key1 = await deriveKey('sekret', salt);
        const key2 = await deriveKey('sekret', salt);
        expect(key1.equals(key2)).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'should produce different keys for different salts',
      async () => {
        const key1 = await deriveKey('sekret', generateSalt());
        const key2 = await deriveKey('sekret', generateSalt());
        expect(key1.equals(key2)).toBe(false);
      },
      TIMEOUT,
    );
  });

  describe('encryptBlob / decryptBlob', () => {
    it(
      'should roundtrip: encrypt then decrypt returns original data',
      async () => {
        const data = Buffer.from('Hello, BFS encryption!', 'utf8');
        const password = 'correcthorsebatterystaple';

        const { encrypted, salt } = await encryptBlob(data, password);
        const decrypted = await decryptBlob(encrypted, password, salt);

        expect(decrypted.equals(data)).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'should throw DecryptionError on wrong password',
      async () => {
        const data = Buffer.from('secret data');
        const { encrypted, salt } = await encryptBlob(data, 'correct-password');

        await expect(
          decryptBlob(encrypted, 'wrong-password', salt),
        ).rejects.toThrow(DecryptionError);
      },
      TIMEOUT,
    );

    it(
      'should throw DecryptionError on wrong salt',
      async () => {
        const data = Buffer.from('secret data');
        const { encrypted } = await encryptBlob(data, 'password');
        const wrongSalt = generateSalt();

        await expect(
          decryptBlob(encrypted, 'password', wrongSalt),
        ).rejects.toThrow(DecryptionError);
      },
      TIMEOUT,
    );

    it(
      'should roundtrip empty data',
      async () => {
        const data = Buffer.alloc(0);
        const { encrypted, salt } = await encryptBlob(data, 'password');
        const decrypted = await decryptBlob(encrypted, 'password', salt);

        expect(decrypted.equals(data)).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'should roundtrip large data (1MB+)',
      async () => {
        const data = Buffer.alloc(1.5 * 1024 * 1024);
        for (let i = 0; i < data.length; i++) data[i] = i % 256;

        const { encrypted, salt } = await encryptBlob(data, 'password');
        const decrypted = await decryptBlob(encrypted, 'password', salt);

        expect(decrypted.equals(data)).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'should produce different ciphertexts for same input (random nonce)',
      async () => {
        const data = Buffer.from('same data');
        const { encrypted: e1, salt: s1 } = await encryptBlob(data, 'pw');
        const { encrypted: e2, salt: s2 } = await encryptBlob(data, 'pw');

        // Różne nonce → różny ciphertext (nawet jeśli hasło i dane identyczne)
        expect(e1.equals(e2)).toBe(false);
        // Każda wersja ma swój salt
        expect(s1.equals(s2)).toBe(false);
      },
      TIMEOUT,
    );
  });

  describe('decryptBlobWithKey', () => {
    it(
      'should decrypt using pre-derived key without Argon2',
      async () => {
        const data = Buffer.from('data for key-based decrypt');
        const { encrypted, key } = await encryptBlob(data, 'password');

        const decrypted = decryptBlobWithKey(encrypted, key);
        expect(decrypted.equals(data)).toBe(true);
      },
      TIMEOUT,
    );

    it(
      'should throw DecryptionError on wrong key',
      async () => {
        const data = Buffer.from('secret');
        const { encrypted } = await encryptBlob(data, 'password');
        const wrongKey = Buffer.alloc(32, 0xff);

        expect(() => decryptBlobWithKey(encrypted, wrongKey)).toThrow(
          DecryptionError,
        );
      },
      TIMEOUT,
    );
  });

  describe('encryptLocationMap / decryptLocationMap', () => {
    it(
      'should roundtrip location map with the same key',
      async () => {
        const salt = generateSalt();
        const key = await deriveKey('password', salt);

        const encrypted = encryptLocationMap(SAMPLE_LOCATIONS, key);
        const decrypted = decryptLocationMap(encrypted, key);

        expect(decrypted).toEqual(SAMPLE_LOCATIONS);
      },
      TIMEOUT,
    );

    it(
      'should roundtrip using key derived from password + salt (recovery simulation)',
      async () => {
        const password = 'recovery-password';
        const salt = generateSalt();

        // Szyfrowanie — jak przy push
        const keyForEncrypt = await deriveKey(password, salt);
        const encrypted = encryptLocationMap(SAMPLE_LOCATIONS, keyForEncrypt);

        // Deszyfrowanie — jak przy recovery: salt z nagłówka sharda, hasło od usera
        const keyForDecrypt = await deriveKey(password, salt);
        const decrypted = decryptLocationMap(encrypted, keyForDecrypt);

        expect(decrypted).toEqual(SAMPLE_LOCATIONS);
      },
      TIMEOUT,
    );

    it(
      'should throw DecryptionError on wrong key',
      async () => {
        const key = await deriveKey('password', generateSalt());
        const encrypted = encryptLocationMap(SAMPLE_LOCATIONS, key);
        const wrongKey = Buffer.alloc(32, 0xaa);

        expect(() => decryptLocationMap(encrypted, wrongKey)).toThrow(
          DecryptionError,
        );
      },
      TIMEOUT,
    );

    it(
      'should produce different ciphertexts on each call (random nonce)',
      async () => {
        const key = await deriveKey('password', generateSalt());
        const e1 = encryptLocationMap(SAMPLE_LOCATIONS, key);
        const e2 = encryptLocationMap(SAMPLE_LOCATIONS, key);

        expect(e1.equals(e2)).toBe(false);
      },
      TIMEOUT,
    );
  });
});
