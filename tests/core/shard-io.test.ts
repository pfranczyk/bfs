import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { generateSalt } from '../../src/core/crypto.js';
import { BfsError, DecryptionError, ShardCorruptedError } from '../../src/core/errors.js';
import { hashBuffer, streamToBuffer } from '../../src/core/hash.js';
import { buildShard, buildShardHeaderFromBytes, buildShardStream, buildSidecarBytes, matchShardIdentity, parseShardHeaderFromStream, readShardHeader, serializeShardHeader } from '../../src/core/shard-io.js';
import type { RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';

// ─── Test fixtures ─────────────────────────────────────────────────────────

const TEST_VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_BLOB_HASH = 'a'.repeat(64); // 32 hex-encoded bytes

const TEST_LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'local-disk', provider_type: 'local', adapterPackage: null, connection_config: { path: '/mnt/backup' }, required_inputs: [], remote_path: '/mnt/backup/myvault/shard_0.bfs.1', shard_hash: 'b'.repeat(64) },
  { shard_index: 1, provider_id: 'usb-drive', provider_type: 'local', adapterPackage: null, connection_config: { path: '/mnt/usb' }, required_inputs: [], remote_path: '/mnt/usb/myvault/shard_1.bfs.1', shard_hash: 'c'.repeat(64) },
  {
    shard_index: 2,
    provider_id: 'ftp-server',
    provider_type: 'ftp',
    adapterPackage: null,
    connection_config: { host: 'ftp.example.com', port: 21 },
    required_inputs: [],
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
    // serializeShardHeader emits V2, where rs_stripe_size is a required positive
    // field (the read path now rejects 0); default to a legal stripe so generic
    // fixtures round-trip. Tests that exercise the clamp override this per case.
    rs_stripe_size: 64 * 1024 * 1024,
    map_length: 0, // computed during build
    location_map: TEST_LOCATIONS,
    ...overrides,
  };
}

const TEST_PAYLOAD = Buffer.from('Hello, BFS shard payload! '.repeat(20));

// ─── Helper: parse shard buffer and collect payload ─────────────────────────

async function parseShard(shard: Buffer, key?: Buffer): Promise<{ header: ShardHeader; payload: Buffer }> {
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shard), key);
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
      expect(h.location_map[1].remote_path).toBe('/mnt/usb/myvault/shard_1.bfs.1');
      expect(h.location_map[2].connection_config).toEqual({ host: 'ftp.example.com', port: 21 });
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
      const header = makeHeader({ version: 999, shard_index: 5, data_shards: 4, parity_shards: 2 });
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
      const { header: h } = await parseShardHeaderFromStream(Readable.from(shard));
      expect(h.encrypted).toBe(true);
      expect(h.location_map).toHaveLength(0);
    });

    it('should throw DecryptionError when wrong key is used', async () => {
      const salt = generateSalt();
      const correctKey = Buffer.alloc(32, 0x11);
      const wrongKey = Buffer.alloc(32, 0x22);
      const header = makeHeader({ encrypted: true, kdf_salt: salt });

      const shard = buildShard(header, TEST_PAYLOAD, correctKey);

      await expect(parseShard(shard, wrongKey)).rejects.toThrow(DecryptionError);
    });
  });

  describe('parseShardHeaderFromStream (header-only, no key)', () => {
    it('should parse metadata without key (unencrypted) — location_map populated', async () => {
      const header = makeHeader({ shard_index: 3, version: 42 });
      const shard = buildShard(header, TEST_PAYLOAD);

      const { header: h } = await parseShardHeaderFromStream(Readable.from(shard));

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
      const header = makeHeader({ encrypted: true, kdf_salt: salt, shard_index: 1 });
      const shard = buildShard(header, TEST_PAYLOAD, encryptionKey);

      // Can call without key — should not throw, location_map stays []
      const { header: h } = await parseShardHeaderFromStream(Readable.from(shard));

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
      const { header: meta } = await parseShardHeaderFromStream(Readable.from(shard));
      expect(meta.kdf_salt).not.toBeNull();
      expect(meta.kdf_salt).toEqual(salt);

      // Step 2: use salt to derive key, then parse full shard
      const { header: h } = await parseShardHeaderFromStream(Readable.from(shard), encryptionKey);
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

      await expect(parseShardHeaderFromStream(Readable.from(corrupted))).rejects.toThrow(ShardCorruptedError);
      await expect(parseShardHeaderFromStream(Readable.from(corrupted))).rejects.toThrow(/magic/i);
    });

    it('should throw ShardCorruptedError for stream too short', async () => {
      const buf = Buffer.alloc(3, 0); // too short for any valid shard

      await expect(parseShardHeaderFromStream(Readable.from(buf))).rejects.toThrow(ShardCorruptedError);
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
      const header = makeHeader({ shard_index: 1, version: 5, rs_stripe_size: 64 * 1024 * 1024 });
      const serializedHeader = serializeShardHeader(header);
      const payloadInput = Readable.from(TEST_PAYLOAD);
      const shardStream = buildShardStream(serializedHeader, payloadInput);

      const shardBuf = await streamToBuffer(shardStream);
      const { header: h, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBuf));
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
      const shardStream = buildShardStream(serializedHeader, Readable.from(TEST_PAYLOAD));
      const shardBuf = await streamToBuffer(shardStream);

      const corrupted = Buffer.from(shardBuf);
      corrupted[corrupted.length - 40] ^= 0x01; // tamper payload region

      const { payloadStream } = await parseShardHeaderFromStream(Readable.from(corrupted));
      await expect(streamToBuffer(payloadStream)).rejects.toThrow(ShardCorruptedError);
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

      const legacyMap = TEST_LOCATIONS.map(({ adapterPackage: _ap, required_inputs: _ri, ...rest }) => rest);
      const legacyJsonBytes = Buffer.from(JSON.stringify(legacyMap), 'utf8');

      const mapLenOffset = jsonStart - 4;
      const prefix = Buffer.from(shard.subarray(0, mapLenOffset));
      const afterJson = Buffer.from(shard.subarray(jsonStart + modernJsonBytes.length, shard.length - 32));

      const newMapLen = Buffer.alloc(4);
      newMapLen.writeUInt32LE(legacyJsonBytes.length, 0);

      const body = Buffer.concat([prefix, newMapLen, legacyJsonBytes, afterJson]);
      const checksum = Buffer.from(hashBuffer(body), 'hex');
      const legacyShard = Buffer.concat([body, checksum]);

      const { header: parsed } = await parseShard(legacyShard);

      expect(parsed.location_map).toHaveLength(TEST_LOCATIONS.length);
      for (const loc of parsed.location_map) {
        expect(loc.adapterPackage).toBeNull();
        // Legacy shard omits required_inputs → null marks "secret still inline".
        expect(loc.required_inputs).toBeNull();
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
      const legacyMap = TEST_LOCATIONS.map(({ adapterPackage: _ap, required_inputs: _ri, ...rest }) => rest);

      // We can't easily swap only the encrypted bytes in-place, so instead
      // serialize a fresh header whose `location_map` is cast to the legacy
      // shape. serializeHeader uses JSON.stringify → the legacy keys are
      // the only ones written.
      const legacyHeader: ShardHeader = { ...header, location_map: legacyMap as unknown as ShardLocation[] };
      const legacyShard = buildShard(legacyHeader, TEST_PAYLOAD, key);

      const { header: parsed } = await parseShard(legacyShard, key);

      expect(parsed.location_map).toHaveLength(TEST_LOCATIONS.length);
      for (const loc of parsed.location_map) {
        expect(loc.adapterPackage).toBeNull();
        // Legacy shard omits required_inputs → null marks "secret still inline".
        expect(loc.required_inputs).toBeNull();
      }
    });
  });

  // ─── Sidecar (BFSH) format + readShardHeader ─────────────────────────────

  const TEST_REF: RemoteRef = { provider_id: 'p', path: 'shard_0.bfs.1' };

  /**
   * Minimal StorageProvider stub exercising only the three methods
   * readShardHeader touches: usesSidecar, downloadHeaderSidecar, downloadHeader.
   */
  function stubProvider(opts: { usesSidecar: boolean; sidecar?: Nullable<Buffer>; inShard: Buffer }): StorageProvider {
    return {
      usesSidecar: () => opts.usesSidecar,
      async downloadHeaderSidecar(): Promise<Buffer | null> {
        return opts.sidecar ?? null;
      },
      async downloadHeader(): Promise<Buffer> {
        return opts.inShard;
      },
    } as unknown as StorageProvider;
  }

  describe('buildSidecarBytes + readShardHeader', () => {
    it('should roundtrip a header through the BFSH sidecar', async () => {
      const sidecar = buildSidecarBytes(makeHeader({ shard_index: 2, version: 7 }));
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard: Buffer.alloc(0) });

      const header = await readShardHeader(provider, TEST_REF);

      expect(header.vault_id).toBe(TEST_VAULT_ID);
      expect(header.shard_index).toBe(2);
      expect(header.version).toBe(7);
      expect(header.location_map).toHaveLength(TEST_LOCATIONS.length);
    });

    it('should roundtrip an encrypted header sidecar with the vault key', async () => {
      const salt = generateSalt();
      const key = Buffer.alloc(32, 0x5a);
      const sidecar = buildSidecarBytes(makeHeader({ encrypted: true, kdf_salt: salt }), key);
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard: Buffer.alloc(0) });

      const header = await readShardHeader(provider, TEST_REF, key);

      expect(header.encrypted).toBe(true);
      expect(header.location_map).toHaveLength(TEST_LOCATIONS.length);
      expect(header.location_map[0]?.provider_id).toBe('local-disk');
    });

    it('should let the sidecar win over the in-shard header', async () => {
      // In-shard header carries version 1; sidecar carries version 9.
      const inShard = buildShard(makeHeader({ version: 1 }), TEST_PAYLOAD);
      const sidecar = buildSidecarBytes(makeHeader({ version: 9 }));
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard });

      const header = await readShardHeader(provider, TEST_REF);

      expect(header.version).toBe(9);
    });

    it('should fall back to the in-shard header when no sidecar exists', async () => {
      const inShard = buildShard(makeHeader({ version: 3 }), TEST_PAYLOAD);
      const provider = stubProvider({ usesSidecar: true, sidecar: null, inShard });

      const header = await readShardHeader(provider, TEST_REF);

      expect(header.version).toBe(3);
    });

    it('should ignore any sidecar when usesSidecar() is false', async () => {
      const inShard = buildShard(makeHeader({ version: 4 }), TEST_PAYLOAD);
      // Even if a (stale) sidecar were present, a non-sidecar provider never reads it.
      const sidecar = buildSidecarBytes(makeHeader({ version: 99 }));
      const provider = stubProvider({ usesSidecar: false, sidecar, inShard });

      const header = await readShardHeader(provider, TEST_REF);

      expect(header.version).toBe(4);
    });

    it('should throw on a bit-flip inside the sidecar (checksum)', async () => {
      const sidecar = buildSidecarBytes(makeHeader());
      sidecar[20] ^= 0xff; // flip a byte inside the serialized header
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard: Buffer.alloc(0) });

      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(BfsError);
      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(/checksum/i);
    });

    it('should throw on a sidecar with the wrong magic', async () => {
      const sidecar = buildSidecarBytes(makeHeader());
      sidecar.write('XXXX', 0, 'ascii'); // corrupt the BFSH magic (checksum still covers it)
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard: Buffer.alloc(0) });

      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(BfsError);
      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(/magic/i);
    });

    it('should throw BfsError when building an encrypted sidecar without kdf_salt', () => {
      const key = Buffer.alloc(32, 0x3c);
      expect(() => buildSidecarBytes(makeHeader({ encrypted: true, kdf_salt: null }), key)).toThrow(BfsError);
      expect(() => buildSidecarBytes(makeHeader({ encrypted: true, kdf_salt: null }), key)).toThrow(/kdf_salt/i);
    });

    // Untrusted bytes from an external provider must never escape as a raw
    // RangeError. A header whose name-length field overruns the buffer is the
    // canonical malformed-input case — it must surface as ShardCorruptedError.
    it('should raise ShardCorruptedError (not a raw RangeError) on a bogus name length (in-shard path)', async () => {
      const malformed = Buffer.alloc(40);
      malformed.write('BFSS', 0, 'ascii');
      malformed.writeUInt16LE(1, 4); // format_version
      malformed.writeUInt16LE(0xffff, 22); // vault name length at offset 4+2+16 — overruns the 40-byte buffer
      const provider = stubProvider({ usesSidecar: false, inShard: malformed });

      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(ShardCorruptedError);
    });

    it('should raise ShardCorruptedError when a sidecar wraps a malformed header (valid BFSH checksum)', async () => {
      const inner = Buffer.alloc(40);
      inner.write('BFSS', 0, 'ascii');
      inner.writeUInt16LE(1, 4);
      inner.writeUInt16LE(0xffff, 22); // bogus name length inside an otherwise well-framed sidecar
      const prefix = Buffer.alloc(8);
      prefix.write('BFSH', 0, 'ascii');
      prefix.writeUInt32LE(1, 4);
      const body = Buffer.concat([prefix, inner]);
      const sidecar = Buffer.concat([body, Buffer.from(hashBuffer(body), 'hex')]);
      const provider = stubProvider({ usesSidecar: true, sidecar, inShard: Buffer.alloc(0) });

      await expect(readShardHeader(provider, TEST_REF)).rejects.toThrow(ShardCorruptedError);
    });
  });

  describe('matchShardIdentity', () => {
    it('should return null when identity matches', () => {
      const header = makeHeader({ shard_index: 2, version: 5 });
      expect(matchShardIdentity(header, { vault_id: TEST_VAULT_ID, shard_index: 2, version: 5 })).toBeNull();
    });

    it('should report a version mismatch with stringified values', () => {
      const header = makeHeader({ version: 4 });
      const mismatch = matchShardIdentity(header, { vault_id: TEST_VAULT_ID, shard_index: 0, version: 5 });
      expect(mismatch).toEqual({ field: 'version', expected: '5', actual: '4' });
    });

    it('should report a shard_index mismatch before version', () => {
      const header = makeHeader({ shard_index: 0, version: 4 });
      const mismatch = matchShardIdentity(header, { vault_id: TEST_VAULT_ID, shard_index: 1, version: 5 });
      expect(mismatch?.field).toBe('shard_index');
    });

    it('should report a vault_id mismatch first of all', () => {
      const header = makeHeader();
      const mismatch = matchShardIdentity(header, { vault_id: 'different', shard_index: 9, version: 9 });
      expect(mismatch?.field).toBe('vault_id');
    });
  });

  // ─── rs_stripe_size clamp from an untrusted header ───────────────────────
  //
  // rsDecodeStriped allocates memory proportional to rs_stripe_size, which is
  // read verbatim from the shard header. Push limits the stripe to
  // V2_MAX_STRIPE_SIZE (256 MiB), but the READ path does not — a crafted header
  // with rs_stripe_size of several GiB (or 0) drives an OOM/RangeError on pull
  // or recovery. The parser must reject rs_stripe_size == 0 and
  // > V2_MAX_STRIPE_SIZE (256 MiB) with a typed ShardCorruptedError, and accept
  // any legal value (including small stripes for tiny blobs) without throwing.
  describe('rs_stripe_size clamp (V2 header read path)', () => {
    const V2_MAX_STRIPE_SIZE = 256 * 1024 * 1024;

    it('should reject an oversized rs_stripe_size (> 256 MiB) with ShardCorruptedError', () => {
      // serializeShardHeader does NOT clamp at write time, so we can emit a
      // well-formed V2 header carrying a 512 MiB stripe. The header is
      // structurally valid — the only thing wrong is the out-of-range stripe.
      const header = makeHeader({ encrypted: false, rs_stripe_size: 512 * 1024 * 1024 });
      const headerBytes = serializeShardHeader(header);

      expect(() => buildShardHeaderFromBytes(headerBytes)).toThrow(ShardCorruptedError);
    });

    it('should reject rs_stripe_size == 0 with ShardCorruptedError', () => {
      const header = makeHeader({ encrypted: false, rs_stripe_size: 0 });
      const headerBytes = serializeShardHeader(header);

      expect(() => buildShardHeaderFromBytes(headerBytes)).toThrow(ShardCorruptedError);
    });

    it('should accept rs_stripe_size exactly at the cap (256 MiB) and reject cap+1', () => {
      // Pins the boundary so the fix must be `> cap` (cap itself legal), not
      // `>= cap` — both would pass a 512-MiB-only test, so this nails off-by-one.
      const atCap = makeHeader({ encrypted: false, rs_stripe_size: V2_MAX_STRIPE_SIZE });
      const overCap = makeHeader({ encrypted: false, rs_stripe_size: V2_MAX_STRIPE_SIZE + 1 });

      const atCapBytes = serializeShardHeader(atCap);
      const overCapBytes = serializeShardHeader(overCap);

      expect(() => buildShardHeaderFromBytes(atCapBytes)).not.toThrow();
      expect(buildShardHeaderFromBytes(atCapBytes).rs_stripe_size).toBe(V2_MAX_STRIPE_SIZE);
      expect(() => buildShardHeaderFromBytes(overCapBytes)).toThrow(ShardCorruptedError);
    });

    it('should accept a legal rs_stripe_size (64 MiB and 1 MiB) without throwing', () => {
      const big = makeHeader({ encrypted: false, rs_stripe_size: 64 * 1024 * 1024 });
      const small = makeHeader({ encrypted: false, rs_stripe_size: 1 * 1024 * 1024 });

      const bigBytes = serializeShardHeader(big);
      const smallBytes = serializeShardHeader(small);

      expect(() => buildShardHeaderFromBytes(bigBytes)).not.toThrow();
      expect(() => buildShardHeaderFromBytes(smallBytes)).not.toThrow();

      // Sanity: 64 MiB is below the cap, so it is a legal value, not an accident.
      expect(64 * 1024 * 1024).toBeLessThanOrEqual(V2_MAX_STRIPE_SIZE);
      expect(buildShardHeaderFromBytes(bigBytes).rs_stripe_size).toBe(64 * 1024 * 1024);
      expect(buildShardHeaderFromBytes(smallBytes).rs_stripe_size).toBe(1 * 1024 * 1024);
    });
  });
});
