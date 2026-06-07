import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  decryptBlob,
  decryptBlobWithKey,
  decryptLocationMap,
  decryptStream,
  deriveKey,
  deriveShardNonce,
  encryptBlob,
  encryptLocationMap,
  encryptStream,
  exceedsGcmPlaintextLimit,
  GCM_MAX_PLAINTEXT_BYTES,
  generateSalt,
} from '../../src/core/crypto.js';
import { DecryptionError } from '../../src/core/errors.js';
import { streamToBuffer } from '../../src/core/hash.js';
import type { ShardLocation } from '../../src/types/index.js';

// Argon2id z parametrami produkcyjnymi (64 MiB) jest wolny — wyższy timeout.
const TIMEOUT = 30_000;

const SAMPLE_LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'local-1', provider_type: 'local', adapterPackage: null, connection_config: { path: '/backup' }, required_inputs: [], remote_path: '/backup/vault/shard_0.bfs.1', shard_hash: 'abc123' },
  { shard_index: 1, provider_id: 'ftp-1', provider_type: 'ftp', adapterPackage: null, connection_config: { host: '192.168.1.10', port: 21 }, required_inputs: [], remote_path: '/backup/vault/shard_1.bfs.1', shard_hash: 'def456' },
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

        await expect(decryptBlob(encrypted, 'wrong-password', salt)).rejects.toThrow(DecryptionError);
      },
      TIMEOUT,
    );

    it(
      'should throw DecryptionError on wrong salt',
      async () => {
        const data = Buffer.from('secret data');
        const { encrypted } = await encryptBlob(data, 'password');
        const wrongSalt = generateSalt();

        await expect(decryptBlob(encrypted, 'password', wrongSalt)).rejects.toThrow(DecryptionError);
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

        expect(() => decryptBlobWithKey(encrypted, wrongKey)).toThrow(DecryptionError);
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

        expect(() => decryptLocationMap(encrypted, wrongKey)).toThrow(DecryptionError);
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

  describe('deriveShardNonce', () => {
    it('should return a 12-byte Buffer', () => {
      const key = Buffer.alloc(32, 0x01);
      const nonce = deriveShardNonce(key, 1, 0);
      expect(nonce).toBeInstanceOf(Buffer);
      expect(nonce.length).toBe(12);
    });

    it('should produce different nonces for different shard indices', () => {
      const key = Buffer.alloc(32, 0x01);
      const n0 = deriveShardNonce(key, 1, 0);
      const n1 = deriveShardNonce(key, 1, 1);
      expect(n0.equals(n1)).toBe(false);
    });

    it('should produce different nonces for different versions', () => {
      const key = Buffer.alloc(32, 0x01);
      const nA = deriveShardNonce(key, 1, 0);
      const nB = deriveShardNonce(key, 2, 0);
      expect(nA.equals(nB)).toBe(false);
    });

    it('should be deterministic — same inputs yield same nonce', () => {
      const key = Buffer.alloc(32, 0xab);
      const n1 = deriveShardNonce(key, 7, 3);
      const n2 = deriveShardNonce(key, 7, 3);
      expect(n1.equals(n2)).toBe(true);
    });
  });

  describe('encryptStream / decryptStream', () => {
    const TEST_KEY = Buffer.alloc(32, 0x42);
    const TEST_NONCE = Buffer.alloc(12, 0x11);

    it('should roundtrip arbitrary plaintext', async () => {
      const plaintext = Buffer.from('Hello, streaming AES-256-GCM!'.repeat(100));

      const encrypted = await streamToBuffer(encryptStream(Readable.from(plaintext), TEST_KEY, TEST_NONCE));
      const decrypted = await streamToBuffer(decryptStream(Readable.from(encrypted), TEST_KEY, TEST_NONCE));

      expect(decrypted).toEqual(plaintext);
    });

    it('should roundtrip empty plaintext', async () => {
      const plaintext = Buffer.alloc(0);

      const encrypted = await streamToBuffer(encryptStream(Readable.from(plaintext), TEST_KEY, TEST_NONCE));
      const decrypted = await streamToBuffer(decryptStream(Readable.from(encrypted), TEST_KEY, TEST_NONCE));

      expect(decrypted).toEqual(plaintext);
    });

    it('should produce ciphertext longer than plaintext (auth tag appended)', async () => {
      const plaintext = Buffer.from('test data');
      const encrypted = await streamToBuffer(encryptStream(Readable.from(plaintext), TEST_KEY, TEST_NONCE));
      // Output = ciphertext (same length as plaintext) + 16B tag
      expect(encrypted.length).toBe(plaintext.length + 16);
    });

    it('should throw DecryptionError when auth tag is tampered', async () => {
      const plaintext = Buffer.from('sensitive data');
      const encrypted = await streamToBuffer(encryptStream(Readable.from(plaintext), TEST_KEY, TEST_NONCE));

      // Corrupt the auth tag (last 16 bytes)
      const tampered = Buffer.from(encrypted);
      tampered[tampered.length - 1] ^= 0xff;

      await expect(streamToBuffer(decryptStream(Readable.from(tampered), TEST_KEY, TEST_NONCE))).rejects.toThrow(DecryptionError);
    });

    it('should throw DecryptionError when stream is too short (missing tag)', async () => {
      const tooShort = Buffer.alloc(10); // less than 16-byte tag

      await expect(streamToBuffer(decryptStream(Readable.from(tooShort), TEST_KEY, TEST_NONCE))).rejects.toThrow(DecryptionError);
    });

    it('should throw DecryptionError when wrong key is used', async () => {
      const plaintext = Buffer.from('secret data');
      const encrypted = await streamToBuffer(encryptStream(Readable.from(plaintext), TEST_KEY, TEST_NONCE));

      const wrongKey = Buffer.alloc(32, 0x99);
      await expect(streamToBuffer(decryptStream(Readable.from(encrypted), wrongKey, TEST_NONCE))).rejects.toThrow(DecryptionError);
    });
  });

  // Guards the AES-GCM 32-bit block-counter wrap: a single (key, nonce) must
  // never encrypt more than ~64 GiB. The predicate is a pure size comparison so
  // these run without allocating tens of gigabytes.
  describe('exceedsGcmPlaintextLimit', () => {
    it('should set the limit to 60 GiB', () => {
      expect(GCM_MAX_PLAINTEXT_BYTES).toBe(60 * 1024 ** 3);
    });

    it('should not flag a payload at exactly the limit', () => {
      expect(exceedsGcmPlaintextLimit(GCM_MAX_PLAINTEXT_BYTES)).toBe(false);
    });

    it('should flag a payload one byte over the limit', () => {
      expect(exceedsGcmPlaintextLimit(GCM_MAX_PLAINTEXT_BYTES + 1)).toBe(true);
    });

    it('should not flag a small payload', () => {
      expect(exceedsGcmPlaintextLimit(1024)).toBe(false);
    });
  });
});
