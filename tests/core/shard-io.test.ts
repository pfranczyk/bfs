import { describe, expect, it } from 'vitest';
import { generateSalt } from '../../src/core/crypto.js';
import {
  BfsError,
  DecryptionError,
  ShardCorruptedError,
} from '../../src/core/errors.js';
import {
  buildShard,
  parseShard,
  parseShardHeaderOnly,
} from '../../src/core/shard-io.js';
import type { ShardHeader, ShardLocation } from '../../src/types/index.js';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const TEST_VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_BLOB_HASH = 'a'.repeat(64); // 32 hex-encoded bytes

const TEST_LOCATIONS: ShardLocation[] = [
  {
    shard_index: 0,
    provider_id: 'local-disk',
    provider_type: 'local',
    connection_config: { path: '/mnt/backup' },
    remote_path: '/mnt/backup/myvault/shard_0.bfs.1',
    shard_hash: 'b'.repeat(64),
  },
  {
    shard_index: 1,
    provider_id: 'usb-drive',
    provider_type: 'local',
    connection_config: { path: '/mnt/usb' },
    remote_path: '/mnt/usb/myvault/shard_1.bfs.1',
    shard_hash: 'c'.repeat(64),
  },
  {
    shard_index: 2,
    provider_id: 'ftp-server',
    provider_type: 'ftp',
    connection_config: { host: 'ftp.example.com', port: 21 },
    remote_path: '/backup/myvault/shard_2.bfs.1',
    shard_hash: 'd'.repeat(64),
  },
];

function makeHeader(overrides: Partial<ShardHeader> = {}): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 1,
    vault_id: TEST_VAULT_ID,
    vault_name: 'myvault',
    blob_size: 1024n,
    blob_hash: TEST_BLOB_HASH,
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    map_length: 0, // computed during build
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
}

const TEST_PAYLOAD = Buffer.from('Hello, BFS shard payload! '.repeat(20));

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('shard-io', () => {
  describe('buildShard + parseShard roundtrip (no encryption)', () => {
    it('should preserve header fields and payload', () => {
      const header = makeHeader();
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h, payload } = parseShard(shard);

      expect(h.magic).toBe('BFSS');
      expect(h.format_version).toBe(1);
      expect(h.vault_id).toBe(TEST_VAULT_ID);
      expect(h.vault_name).toBe('myvault');
      expect(h.blob_size).toBe(1024n);
      expect(h.blob_hash).toBe(TEST_BLOB_HASH);
      expect(h.data_shards).toBe(2);
      expect(h.parity_shards).toBe(1);
      expect(h.shard_index).toBe(0);
      expect(h.version).toBe(1);
      expect(h.encrypted).toBe(false);
      expect(h.kdf_salt).toBeNull();
      expect(payload).toEqual(TEST_PAYLOAD);
    });

    it('should preserve location map exactly', () => {
      const header = makeHeader();
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = parseShard(shard);

      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
      expect(h.location_map[0].provider_id).toBe('local-disk');
      expect(h.location_map[1].remote_path).toBe(
        '/mnt/usb/myvault/shard_1.bfs.1',
      );
      expect(h.location_map[2].connection_config).toEqual({
        host: 'ftp.example.com',
        port: 21,
      });
    });

    it('should handle binary payload correctly', () => {
      const binaryPayload = Buffer.alloc(512);
      for (let i = 0; i < 512; i++) binaryPayload[i] = i % 256;

      const shard = buildShard(makeHeader(), binaryPayload);
      const { payload } = parseShard(shard);

      expect(payload).toEqual(binaryPayload);
    });

    it('should handle UTF-8 vault name with special chars', () => {
      const header = makeHeader({ vault_name: 'Zdjęcia-2025' });
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = parseShard(shard);
      expect(h.vault_name).toBe('Zdjęcia-2025');
    });

    it('should handle empty payload', () => {
      const empty = Buffer.alloc(0);
      const shard = buildShard(makeHeader(), empty);
      const { payload } = parseShard(shard);
      expect(payload.length).toBe(0);
    });

    it('should handle large version numbers', () => {
      const header = makeHeader({
        version: 999,
        shard_index: 5,
        data_shards: 4,
        parity_shards: 2,
      });
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = parseShard(shard);
      expect(h.version).toBe(999);
      expect(h.shard_index).toBe(5);
      expect(h.data_shards).toBe(4);
      expect(h.parity_shards).toBe(2);
    });
  });

  describe('buildShard + parseShard roundtrip (with encryption)', () => {
    it('should encrypt and decrypt location map correctly', () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0xab); // 32-byte test key
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);
      const { header: h, payload } = parseShard(shard, encryptionKey);

      expect(h.encrypted).toBe(true);
      expect(h.kdf_salt).toEqual(salt);
      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
      expect(h.location_map[0].provider_id).toBe('local-disk');
      expect(payload).toEqual(TEST_PAYLOAD);
    });

    it('should produce different bytes each time due to random nonce', () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0xcd);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard1 = buildShard(header, TEST_PAYLOAD, encryptionKey);
      const shard2 = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Due to random nonce, the two shards should differ
      expect(shard1.equals(shard2)).toBe(false);
    });

    it('should throw DecryptionError when encrypted shard is parsed without key', () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0xef);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      expect(() => parseShard(shard)).toThrow(DecryptionError);
      expect(() => parseShard(shard)).toThrow(/key/i);
    });

    it('should throw DecryptionError when wrong key is used', () => {
      const salt = generateSalt();
      const correctKey = Buffer.alloc(32, 0x11);
      const wrongKey = Buffer.alloc(32, 0x22);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, correctKey);

      expect(() => parseShard(shard, wrongKey)).toThrow(DecryptionError);
    });
  });

  describe('parseShardHeaderOnly', () => {
    it('should parse header metadata without key (unencrypted)', () => {
      const header = makeHeader({ shard_index: 3, version: 42 });
      const shard = buildShard(header, TEST_PAYLOAD);

      const meta = parseShardHeaderOnly(shard);

      expect(meta.magic).toBe('BFSS');
      expect(meta.vault_id).toBe(TEST_VAULT_ID);
      expect(meta.vault_name).toBe('myvault');
      expect(meta.shard_index).toBe(3);
      expect(meta.version).toBe(42);
      expect(meta.encrypted).toBe(false);
      expect(meta.kdf_salt).toBeNull();
      // location_map must NOT be present
      expect((meta as ShardHeader).location_map).toBeUndefined();
    });

    it('should parse header metadata without key (encrypted)', () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0x55);
      const header = makeHeader({
        encrypted: true,
        kdf_salt: salt,
        shard_index: 1,
      });
      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Can call without key — should not throw
      const meta = parseShardHeaderOnly(shard);

      expect(meta.encrypted).toBe(true);
      expect(meta.kdf_salt).toEqual(salt);
      expect(meta.shard_index).toBe(1);
      // location_map must NOT be present
      expect((meta as ShardHeader).location_map).toBeUndefined();
    });

    it('should expose kdf_salt for key derivation flow', () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0x77);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });
      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Step 1: discover salt without key
      const meta = parseShardHeaderOnly(shard);
      expect(meta.kdf_salt).not.toBeNull();
      expect(meta.kdf_salt).toEqual(salt);

      // Step 2: use salt to derive key, then parse full shard
      const { header: h } = parseShard(shard, encryptionKey);
      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
    });
  });

  describe('checksum validation', () => {
    it('should throw ShardCorruptedError when checksum is wrong', () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      // Corrupt one byte in the middle of the shard
      const corrupted = Buffer.from(shard);
      corrupted[50] ^= 0xff;

      expect(() => parseShard(corrupted)).toThrow(ShardCorruptedError);
      expect(() => parseShard(corrupted)).toThrow(/checksum/i);
    });

    it('should throw ShardCorruptedError when payload is tampered', () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      const corrupted = Buffer.from(shard);
      // Flip a bit near the end (in the payload area, before the checksum)
      corrupted[corrupted.length - 40] ^= 0x01;

      expect(() => parseShard(corrupted)).toThrow(ShardCorruptedError);
    });

    it('should throw ShardCorruptedError when magic bytes are wrong', () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      const corrupted = Buffer.from(shard);
      corrupted.write('XXXX', 0, 'ascii');

      expect(() => parseShard(corrupted)).toThrow(ShardCorruptedError);
      expect(() => parseShard(corrupted)).toThrow(/magic/i);
    });

    it('should throw ShardCorruptedError for invalid magic in parseShardHeaderOnly', () => {
      const buf = Buffer.alloc(64, 0);
      buf.write('NOPE', 0, 'ascii');

      expect(() => parseShardHeaderOnly(buf)).toThrow(ShardCorruptedError);
      expect(() => parseShardHeaderOnly(buf)).toThrow(/magic/i);
    });
  });

  describe('buildShard — encrypted header validation', () => {
    it('should throw BfsError when encrypted=true but kdf_salt is null', () => {
      const header = makeHeader({ encrypted: true, kdf_salt: null });
      const key = Buffer.alloc(32, 0xaa);

      expect(() => buildShard(header, TEST_PAYLOAD, key)).toThrow(BfsError);
      expect(() => buildShard(header, TEST_PAYLOAD, key)).toThrow(/kdf_salt/i);
    });

    it('should throw BfsError when encrypted=true but kdf_salt has wrong length', () => {
      const header = makeHeader({ encrypted: true, kdf_salt: Buffer.alloc(8) }); // 8 bytes instead of 16
      const key = Buffer.alloc(32, 0xaa);

      expect(() => buildShard(header, TEST_PAYLOAD, key)).toThrow(BfsError);
      expect(() => buildShard(header, TEST_PAYLOAD, key)).toThrow(/kdf_salt/i);
    });
  });
});
