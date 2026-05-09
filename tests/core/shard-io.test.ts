import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { generateSalt } from '../../src/core/crypto.js';
import {
  BfsError,
  DecryptionError,
  ShardCorruptedError,
} from '../../src/core/errors.js';
import { hashBuffer, streamToBuffer } from '../../src/core/hash.js';
import {
  buildShard,
  buildShardStream,
  parseShardHeaderFromStream,
  serializeShardHeader,
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
    adapterPackage: null,
    connection_config: { path: '/mnt/backup' },
    remote_path: '/mnt/backup/myvault/shard_0.bfs.1',
    shard_hash: 'b'.repeat(64),
  },
  {
    shard_index: 1,
    provider_id: 'usb-drive',
    provider_type: 'local',
    adapterPackage: null,
    connection_config: { path: '/mnt/usb' },
    remote_path: '/mnt/usb/myvault/shard_1.bfs.1',
    shard_hash: 'c'.repeat(64),
  },
  {
    shard_index: 2,
    provider_id: 'ftp-server',
    provider_type: 'ftp',
    adapterPackage: null,
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
    rs_stripe_size: null,
    map_length: 0, // computed during build
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
}

const TEST_PAYLOAD = Buffer.from('Hello, BFS shard payload! '.repeat(20));

// ─── Helper: parse shard buffer and collect payload ─────────────────────────

async function parseShard(
  shard: Buffer,
  key?: Buffer,
): Promise<{ header: ShardHeader; payload: Buffer }> {
  const { header, payloadStream } = await parseShardHeaderFromStream(
    Readable.from(shard),
    key,
  );
  const payload = await streamToBuffer(payloadStream);
  return { header, payload };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('shard-io', () => {
  describe('buildShard + parseShardHeaderFromStream roundtrip (no encryption)', () => {
    it('should preserve header fields and payload', async () => {
      const header = makeHeader();
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h, payload } = await parseShard(shard);

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

    it('should preserve location map exactly', async () => {
      const header = makeHeader();
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = await parseShard(shard);

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

    it('should handle binary payload correctly', async () => {
      const binaryPayload = Buffer.alloc(512);
      for (let i = 0; i < 512; i++) binaryPayload[i] = i % 256;

      const shard = buildShard(makeHeader(), binaryPayload);
      const { payload } = await parseShard(shard);

      expect(payload).toEqual(binaryPayload);
    });

    it('should handle UTF-8 vault name with special chars', async () => {
      const header = makeHeader({ vault_name: 'Zdjęcia-2025' });
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = await parseShard(shard);
      expect(h.vault_name).toBe('Zdjęcia-2025');
    });

    it('should handle empty payload', async () => {
      const empty = Buffer.alloc(0);
      const shard = buildShard(makeHeader(), empty);
      const { payload } = await parseShard(shard);
      expect(payload.length).toBe(0);
    });

    it('should handle large version numbers', async () => {
      const header = makeHeader({
        version: 999,
        shard_index: 5,
        data_shards: 4,
        parity_shards: 2,
      });
      const shard = buildShard(header, TEST_PAYLOAD);
      const { header: h } = await parseShard(shard);
      expect(h.version).toBe(999);
      expect(h.shard_index).toBe(5);
      expect(h.data_shards).toBe(4);
      expect(h.parity_shards).toBe(2);
    });
  });

  describe('buildShard + parseShardHeaderFromStream roundtrip (with encryption)', () => {
    it('should encrypt and decrypt location map correctly', async () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0xab); // 32-byte test key
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);
      const { header: h, payload } = await parseShard(shard, encryptionKey);

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

    it('should parse without error when encrypted shard is parsed without key (location_map empty)', async () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0xef);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Without key: header parses successfully — location_map stays []
      const { header: h } = await parseShardHeaderFromStream(
        Readable.from(shard),
      );
      expect(h.encrypted).toBe(true);
      expect(h.location_map).toHaveLength(0);
    });

    it('should throw DecryptionError when wrong key is used', async () => {
      const salt = generateSalt();
      const correctKey = Buffer.alloc(32, 0x11);
      const wrongKey = Buffer.alloc(32, 0x22);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, correctKey);

      await expect(parseShard(shard, wrongKey)).rejects.toThrow(
        DecryptionError,
      );
    });
  });

  describe('parseShardHeaderFromStream (header-only, no key)', () => {
    it('should parse metadata without key (unencrypted) — location_map populated', async () => {
      const header = makeHeader({ shard_index: 3, version: 42 });
      const shard = buildShard(header, TEST_PAYLOAD);

      const { header: h } = await parseShardHeaderFromStream(
        Readable.from(shard),
      );

      expect(h.magic).toBe('BFSS');
      expect(h.vault_id).toBe(TEST_VAULT_ID);
      expect(h.vault_name).toBe('myvault');
      expect(h.shard_index).toBe(3);
      expect(h.version).toBe(42);
      expect(h.encrypted).toBe(false);
      expect(h.kdf_salt).toBeNull();
      // unencrypted: location_map is always populated
      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
    });

    it('should parse metadata without key (encrypted) — location_map empty', async () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0x55);
      const header = makeHeader({
        encrypted: true,
        kdf_salt: salt,
        shard_index: 1,
      });
      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Can call without key — should not throw, location_map stays []
      const { header: h } = await parseShardHeaderFromStream(
        Readable.from(shard),
      );

      expect(h.encrypted).toBe(true);
      expect(h.kdf_salt).toEqual(salt);
      expect(h.shard_index).toBe(1);
      expect(h.location_map).toHaveLength(0); // not decrypted without key
    });

    it('should expose kdf_salt for key derivation flow', async () => {
      const salt = generateSalt();
      const encryptionKey = Buffer.alloc(32, 0x77);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });
      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Step 1: discover salt without key
      const { header: meta } = await parseShardHeaderFromStream(
        Readable.from(shard),
      );
      expect(meta.kdf_salt).not.toBeNull();
      expect(meta.kdf_salt).toEqual(salt);

      // Step 2: use salt to derive key, then parse full shard
      const { header: h } = await parseShardHeaderFromStream(
        Readable.from(shard),
        encryptionKey,
      );
      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
    });
  });

  describe('checksum validation', () => {
    it('should throw ShardCorruptedError when checksum is wrong', async () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      // Corrupt one byte in the middle of the shard
      const corrupted = Buffer.from(shard);
      corrupted[50] ^= 0xff;

      await expect(parseShard(corrupted)).rejects.toThrow(ShardCorruptedError);
      await expect(parseShard(corrupted)).rejects.toThrow(/checksum/i);
    });

    it('should throw ShardCorruptedError when payload is tampered', async () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      const corrupted = Buffer.from(shard);
      // Flip a bit near the end (in the payload area, before the checksum)
      corrupted[corrupted.length - 40] ^= 0x01;

      await expect(parseShard(corrupted)).rejects.toThrow(ShardCorruptedError);
    });

    it('should throw ShardCorruptedError when magic bytes are wrong', async () => {
      const shard = buildShard(makeHeader(), TEST_PAYLOAD);
      const corrupted = Buffer.from(shard);
      corrupted.write('XXXX', 0, 'ascii');

      await expect(
        parseShardHeaderFromStream(Readable.from(corrupted)),
      ).rejects.toThrow(ShardCorruptedError);
      await expect(
        parseShardHeaderFromStream(Readable.from(corrupted)),
      ).rejects.toThrow(/magic/i);
    });

    it('should throw ShardCorruptedError for stream too short', async () => {
      const buf = Buffer.alloc(3, 0); // too short for any valid shard

      await expect(
        parseShardHeaderFromStream(Readable.from(buf)),
      ).rejects.toThrow(ShardCorruptedError);
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

  describe('buildShardStream + parseShardHeaderFromStream roundtrip (FORMAT_VERSION=2)', () => {
    it('should roundtrip header and payload via stream including rs_stripe_size', async () => {
      const header = makeHeader({
        shard_index: 1,
        version: 5,
        rs_stripe_size: 64 * 1024 * 1024,
      });
      const serializedHeader = serializeShardHeader(header);
      const payloadInput = Readable.from(TEST_PAYLOAD);
      const shardStream = buildShardStream(serializedHeader, payloadInput);

      const shardBuf = await streamToBuffer(shardStream);
      const { header: h, payloadStream } = await parseShardHeaderFromStream(
        Readable.from(shardBuf),
      );
      const payload = await streamToBuffer(payloadStream);

      expect(h.format_version).toBe(2);
      expect(h.rs_stripe_size).toBe(64 * 1024 * 1024);
      expect(h.shard_index).toBe(1);
      expect(h.version).toBe(5);
      expect(h.vault_id).toBe(TEST_VAULT_ID);
      expect(h.location_map).toHaveLength(TEST_LOCATIONS.length);
      expect(payload).toEqual(TEST_PAYLOAD);
    });

    it('should detect checksum corruption in v2 stream shard', async () => {
      const serializedHeader = serializeShardHeader(makeHeader());
      const shardStream = buildShardStream(
        serializedHeader,
        Readable.from(TEST_PAYLOAD),
      );
      const shardBuf = await streamToBuffer(shardStream);

      const corrupted = Buffer.from(shardBuf);
      corrupted[corrupted.length - 40] ^= 0x01; // tamper payload region

      const { payloadStream } = await parseShardHeaderFromStream(
        Readable.from(corrupted),
      );
      await expect(streamToBuffer(payloadStream)).rejects.toThrow(
        ShardCorruptedError,
      );
    });
  });

  // ─── Backward compatibility: legacy shards without adapterPackage ────────
  //
  // Shards produced by BFS versions older than the adapterPackage addition
  // store a location map JSON that lacks this field. The parser must accept
  // them verbatim (no flag, no migration) and return adapterPackage=null for
  // every entry. This is the single most important guarantee of the adapter
  // contract — legacy backups stay fully recoverable.
  describe('backward compat: legacy location map JSON (no adapterPackage)', () => {
    it('should parse legacy plain JSON and fall back to adapterPackage=null', async () => {
      const header = makeHeader();
      const shard = buildShard(header, TEST_PAYLOAD);

      // Locate the modern JSON in the serialized shard and rewrite it into
      // the legacy shape (no "adapterPackage" keys). Then recompute both the
      // map_length (uint32 LE immediately before the JSON bytes) and the
      // trailing SHA-256 checksum so the shard remains structurally valid.
      const modernJson = JSON.stringify(TEST_LOCATIONS);
      const modernJsonBytes = Buffer.from(modernJson, 'utf8');
      const jsonStart = shard.indexOf(modernJsonBytes);
      if (jsonStart < 0) {
        throw new Error('test setup: modern JSON not found in shard');
      }

      const legacyMap = TEST_LOCATIONS.map(
        ({ adapterPackage: _ap, ...rest }) => rest,
      );
      const legacyJsonBytes = Buffer.from(JSON.stringify(legacyMap), 'utf8');

      const mapLenOffset = jsonStart - 4;
      const prefix = Buffer.from(shard.subarray(0, mapLenOffset));
      const afterJson = Buffer.from(
        shard.subarray(jsonStart + modernJsonBytes.length, shard.length - 32),
      );

      const newMapLen = Buffer.alloc(4);
      newMapLen.writeUInt32LE(legacyJsonBytes.length, 0);

      const body = Buffer.concat([
        prefix,
        newMapLen,
        legacyJsonBytes,
        afterJson,
      ]);
      const checksum = Buffer.from(hashBuffer(body), 'hex');
      const legacyShard = Buffer.concat([body, checksum]);

      const { header: parsed } = await parseShard(legacyShard);

      expect(parsed.location_map).toHaveLength(TEST_LOCATIONS.length);
      for (const loc of parsed.location_map) {
        expect(loc.adapterPackage).toBeNull();
      }
      // Other fields must round-trip unchanged.
      expect(parsed.location_map[0]?.provider_id).toBe('local-disk');
      expect(parsed.location_map[2]?.provider_type).toBe('ftp');
    });

    it('should parse legacy encrypted JSON and fall back to adapterPackage=null', async () => {
      const key = Buffer.alloc(32, 0xab);
      const salt = generateSalt();
      const header = makeHeader({ encrypted: true, kdf_salt: salt });
      // Serialize a header whose location_map is the legacy shape (no
      // adapterPackage). serializeHeader → encryptLocationMap runs
      // JSON.stringify on the array, so only the legacy keys hit the
      // encrypted JSON payload — exactly the on-disk shape of a shard
      // produced by a BFS version older than adapterPackage.
      const legacyMap = TEST_LOCATIONS.map(
        ({ adapterPackage: _ap, ...rest }) => rest,
      );

      // We can't easily swap only the encrypted bytes in-place, so instead
      // serialize a fresh header whose `location_map` is cast to the legacy
      // shape. serializeHeader uses JSON.stringify → the legacy keys are
      // the only ones written.
      const legacyHeader: ShardHeader = {
        ...header,
        location_map: legacyMap as unknown as ShardLocation[],
      };
      const legacyShard = buildShard(legacyHeader, TEST_PAYLOAD, key);

      const { header: parsed } = await parseShard(legacyShard, key);

      expect(parsed.location_map).toHaveLength(TEST_LOCATIONS.length);
      for (const loc of parsed.location_map) {
        expect(loc.adapterPackage).toBeNull();
      }
    });
  });
});
