import type { ShardHeader, ShardLocation } from '../types/index.js';
import { decryptLocationMap, encryptLocationMap } from './crypto.js';
import { BfsError, DecryptionError, ShardCorruptedError } from './errors.js';
import { hashBuffer } from './hash.js';

const MAGIC = 'BFSS';
const FORMAT_VERSION = 1;
const CHECKSUM_SIZE = 32;
const SALT_SIZE = 16;

// ─── Shard header size helper ─────────────────────────────────────────────

/**
 * Computes the byte length of the shard header by walking the binary layout
 * without decrypting the location map.
 * Used by providers (updateShardHeader) and vault-manager (extractShardPayload).
 *
 * @param data - Full shard binary buffer
 * @returns Byte offset where the RS payload begins (i.e. header size)
 * @throws BfsError if the buffer is too short or the magic bytes are invalid
 */
export function computeShardHeaderSize(data: Buffer): number {
  if (data.length < 27) {
    throw new BfsError('Shard buffer too short to determine header size');
  }
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new BfsError(`Invalid shard magic: "${magic}"`);
  }
  let pos = 4 + 2 + 16; // magic + version + vault_id
  const nameLen = data.readUInt16LE(pos);
  pos += 2 + nameLen;
  // blob_size(8) + blob_hash(32) + N(2) + K(2) + idx(2) + ver(4) + encrypted(1) = 51
  pos += 51;
  const encrypted = data.readUInt8(pos - 1) !== 0;
  if (encrypted) pos += SALT_SIZE;
  const mapLength = data.readUInt32LE(pos);
  pos += 4 + mapLength;
  return pos;
}

// ─── UUID helpers ──────────────────────────────────────────────────────────

/** Converts a UUID string (e.g. "550e8400-e29b-41d4-a716-446655440000") to a 16-byte Buffer. */
export function uuidToBuffer(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

/** Converts a 16-byte Buffer to a UUID string with dashes. */
function bufferToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── Shard header binary layout ───────────────────────────────────────────
//
// 0x00   4    Magic: "BFSS"
// 0x04   2    Format version: uint16 LE (1)
// 0x06   16   Vault UUID: 16 bytes binary
// 0x16   2    Vault name length: uint16 LE
// 0x18   var  Vault name: UTF-8
// var    8    Blob size: uint64 LE
// var+8  32   Blob hash: SHA-256 as 32 binary bytes
// var+40 2    Data shards N: uint16 LE
// var+42 2    Parity shards K: uint16 LE
// var+44 2    Shard index: uint16 LE
// var+46 4    Version number: uint32 LE
// var+50 1    Encryption flag: uint8
//             --- if encrypted=1: ---
// var+51 16   KDF salt
// var+67 4    Location map length: uint32 LE
// var+71 var  Location map: 12B nonce + ciphertext + 16B auth tag
//             --- if encrypted=0: ---
// var+51 4    Location map length: uint32 LE
// var+55 var  Location map: raw JSON bytes
// ...    var  Shard data payload
// EOF-32 32   SHA-256 of everything above (checksum)

/**
 * Serializes the shard header fields into a binary Buffer.
 * Does NOT include payload or trailing checksum.
 * @param header       - Shard metadata to serialize
 * @param encryptionKey - If provided, encrypts the location map with AES-256-GCM
 * @returns Serialized header Buffer
 */
function serializeHeader(header: ShardHeader, encryptionKey?: Buffer): Buffer {
  const vaultIdBuf = uuidToBuffer(header.vault_id);
  const vaultNameBuf = Buffer.from(header.vault_name, 'utf8');
  const blobHashBuf = Buffer.from(header.blob_hash, 'hex');

  // Build location map payload (encrypted or raw JSON)
  let locationMapPayload: Buffer;
  if (encryptionKey) {
    locationMapPayload = encryptLocationMap(header.location_map, encryptionKey);
  } else {
    locationMapPayload = Buffer.from(
      JSON.stringify(header.location_map),
      'utf8',
    );
  }

  // Compute total header byte count
  const encryptedFieldsSize = header.encrypted ? SALT_SIZE : 0;
  const headerSize =
    4 +
    2 +
    16 + // magic + version + vault_id
    2 +
    vaultNameBuf.length + // name_len + name
    8 +
    32 +
    2 +
    2 +
    2 +
    4 +
    1 + // blob_size + blob_hash + N + K + idx + ver + encrypted
    encryptedFieldsSize + // kdf_salt (only if encrypted)
    4 +
    locationMapPayload.length; // map_length + map_payload

  const buf = Buffer.alloc(headerSize);
  let pos = 0;

  // Magic: "BFSS"
  buf.write(MAGIC, pos, 'ascii');
  pos += 4;
  // Format version: 1
  buf.writeUInt16LE(FORMAT_VERSION, pos);
  pos += 2;
  // Vault UUID: 16 bytes binary
  vaultIdBuf.copy(buf, pos);
  pos += 16;
  // Vault name length + UTF-8 bytes
  buf.writeUInt16LE(vaultNameBuf.length, pos);
  pos += 2;
  vaultNameBuf.copy(buf, pos);
  pos += vaultNameBuf.length;
  // Blob size: uint64 LE
  buf.writeBigUInt64LE(header.blob_size, pos);
  pos += 8;
  // Blob hash: 32 bytes binary
  blobHashBuf.copy(buf, pos);
  pos += 32;
  // Data shards N
  buf.writeUInt16LE(header.data_shards, pos);
  pos += 2;
  // Parity shards K
  buf.writeUInt16LE(header.parity_shards, pos);
  pos += 2;
  // Shard index
  buf.writeUInt16LE(header.shard_index, pos);
  pos += 2;
  // Version number
  buf.writeUInt32LE(header.version, pos);
  pos += 4;
  // Encryption flag
  buf.writeUInt8(header.encrypted ? 1 : 0, pos);
  pos += 1;

  if (header.encrypted) {
    if (!header.kdf_salt || header.kdf_salt.length !== SALT_SIZE) {
      throw new BfsError(
        'kdf_salt (16 bytes) is required when header.encrypted=true',
      );
    }
    header.kdf_salt.copy(buf, pos);
    pos += SALT_SIZE;
  }

  // Location map length + payload
  buf.writeUInt32LE(locationMapPayload.length, pos);
  pos += 4;
  locationMapPayload.copy(buf, pos);
  pos += locationMapPayload.length;

  return buf;
}

/**
 * Builds a complete shard binary from a header and RS payload.
 * Layout: [header][payload][SHA-256 checksum (32 bytes)]
 *
 * @param header        - Shard metadata including location map
 * @param payload       - RS-encoded shard chunk (one shard's data)
 * @param encryptionKey - 32-byte AES-256-GCM key for encrypting the location map.
 *                        Must be provided when header.encrypted=true.
 * @returns Complete shard Buffer ready for storage
 * @throws Error if header.encrypted=true but kdf_salt is missing
 */
export function buildShard(
  header: ShardHeader,
  payload: Buffer,
  encryptionKey?: Buffer,
): Buffer {
  const headerBuf = serializeHeader(header, encryptionKey);
  const body = Buffer.concat([headerBuf, payload]);
  const checksum = Buffer.from(hashBuffer(body), 'hex');
  return Buffer.concat([body, checksum]);
}

// ─── Private parsing helpers ──────────────────────────────────────────────

/**
 * Reads all common shard header fields starting at startPos (i.e. after the 4-byte magic).
 * Used by both parseShard and parseShardHeaderOnly to avoid code duplication.
 * Returns all parsed fields plus the buffer position immediately after map_length.
 */
function parseCommonHeaderFields(data: Buffer, startPos: number) {
  let pos = startPos;

  const format_version = data.readUInt16LE(pos);
  pos += 2;
  const vault_id = bufferToUuid(data.subarray(pos, pos + 16));
  pos += 16;

  const nameLen = data.readUInt16LE(pos);
  pos += 2;
  const vault_name = data.subarray(pos, pos + nameLen).toString('utf8');
  pos += nameLen;

  const blob_size = data.readBigUInt64LE(pos);
  pos += 8;
  const blob_hash = data.subarray(pos, pos + 32).toString('hex');
  pos += 32;

  const data_shards = data.readUInt16LE(pos);
  pos += 2;
  const parity_shards = data.readUInt16LE(pos);
  pos += 2;
  const shard_index = data.readUInt16LE(pos);
  pos += 2;
  const version = data.readUInt32LE(pos);
  pos += 4;

  const encrypted = data.readUInt8(pos) !== 0;
  pos += 1;

  let kdf_salt: Nullable<Buffer> = null;
  if (encrypted) {
    kdf_salt = Buffer.from(data.subarray(pos, pos + SALT_SIZE));
    pos += SALT_SIZE;
  }

  const map_length = data.readUInt32LE(pos);
  pos += 4;

  return {
    format_version,
    vault_id,
    vault_name,
    blob_size,
    blob_hash,
    data_shards,
    parity_shards,
    shard_index,
    version,
    encrypted,
    kdf_salt,
    map_length,
    pos,
  };
}

/**
 * Reads and decodes the location map bytes starting at pos.
 * Decrypts when encrypted=true; parses raw JSON otherwise.
 * Returns the decoded map and the buffer position after the map payload.
 */
function readLocationMap(
  data: Buffer,
  pos: number,
  mapLength: number,
  encrypted: boolean,
  encryptionKey: Buffer | undefined,
): { locationMap: ShardLocation[]; endPos: number } {
  const mapPayload = data.subarray(pos, pos + mapLength);
  const endPos = pos + mapLength;

  if (encrypted) {
    if (!encryptionKey) {
      throw new DecryptionError(
        'This shard is encrypted — provide the encryption key (derive it from the password and kdf_salt)',
      );
    }
    return {
      locationMap: decryptLocationMap(mapPayload, encryptionKey),
      endPos,
    };
  }

  try {
    const locationMap = JSON.parse(
      mapPayload.toString('utf8'),
    ) as ShardLocation[];
    return { locationMap, endPos };
  } catch {
    throw new ShardCorruptedError('Location map JSON is invalid or corrupted');
  }
}

/**
 * Parses a complete shard binary into its header and payload.
 * Verifies the SHA-256 checksum and the magic bytes.
 * If the shard is encrypted, decrypts the location map using the provided key.
 *
 * @param data          - Full shard binary (from file or provider)
 * @param encryptionKey - 32-byte AES key (required if the shard is encrypted)
 * @returns { header: ShardHeader; payload: Buffer }
 * @throws ShardCorruptedError if magic is invalid or checksum fails
 * @throws DecryptionError if encrypted but no key is provided, or decryption fails
 */
export function parseShard(
  data: Buffer,
  encryptionKey?: Buffer,
): { header: ShardHeader; payload: Buffer } {
  if (data.length < CHECKSUM_SIZE + 5) {
    throw new ShardCorruptedError('Shard data too short to be valid');
  }

  // 1. Verify magic first (fast sanity check before expensive checksum computation)
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(
      `Invalid shard magic: expected "BFSS", got "${magic}"`,
    );
  }

  // 2. Verify SHA-256 checksum of the entire body (header + payload)
  const body = data.subarray(0, data.length - CHECKSUM_SIZE);
  const storedChecksum = data.subarray(data.length - CHECKSUM_SIZE);
  if (!storedChecksum.equals(Buffer.from(hashBuffer(body), 'hex'))) {
    throw new ShardCorruptedError(
      'Shard checksum mismatch — data is corrupted or tampered',
    );
  }

  // 3. Parse all common header fields (format_version through map_length)
  const common = parseCommonHeaderFields(data, 4);

  // 4. Read and decode the location map
  const { locationMap, endPos } = readLocationMap(
    data,
    common.pos,
    common.map_length,
    common.encrypted,
    encryptionKey,
  );

  // 5. Extract RS payload (bytes between end of header and trailing checksum)
  const payload = Buffer.from(
    data.subarray(endPos, data.length - CHECKSUM_SIZE),
  );

  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: common.format_version,
    vault_id: common.vault_id,
    vault_name: common.vault_name,
    blob_size: common.blob_size,
    blob_hash: common.blob_hash,
    data_shards: common.data_shards,
    parity_shards: common.parity_shards,
    shard_index: common.shard_index,
    version: common.version,
    encrypted: common.encrypted,
    kdf_salt: common.kdf_salt,
    map_length: common.map_length,
    location_map: locationMap,
  };

  return { header, payload };
}

/**
 * Parses only the shard header metadata without decrypting the location map.
 * Useful for discovery: caller can read vault_id, kdf_salt, N/K scheme, version,
 * and then derive the key (from password + kdf_salt) before calling parseShard.
 *
 * @param data - Full shard binary
 * @returns All ShardHeader fields except location_map
 * @throws ShardCorruptedError if magic is invalid or the buffer is too short
 */
export function parseShardHeaderOnly(
  data: Buffer,
): Omit<ShardHeader, 'location_map'> {
  if (data.length < 10) {
    throw new ShardCorruptedError('Shard data too short to be valid');
  }

  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(
      `Invalid shard magic: expected "BFSS", got "${magic}"`,
    );
  }

  const {
    format_version,
    vault_id,
    vault_name,
    blob_size,
    blob_hash,
    data_shards,
    parity_shards,
    shard_index,
    version,
    encrypted,
    kdf_salt,
    map_length,
  } = parseCommonHeaderFields(data, 4);

  return {
    magic: 'BFSS',
    format_version,
    vault_id,
    vault_name,
    blob_size,
    blob_hash,
    data_shards,
    parity_shards,
    shard_index,
    version,
    encrypted,
    kdf_salt,
    map_length,
  };
}
