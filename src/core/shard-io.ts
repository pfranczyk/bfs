import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';

import type { ShardHeader, ShardLocation } from '../types/index.js';
import { decryptLocationMap, encryptLocationMap } from './crypto.js';
import { BfsError, DecryptionError, ShardCorruptedError } from './errors.js';
import { hashBuffer } from './hash.js';

const MAGIC = 'BFSS';
const FORMAT_VERSION_1 = 1;
const FORMAT_VERSION_2 = 2;
const CHECKSUM_SIZE = 32;
const SALT_SIZE = 16;
// Minimum bytes needed to determine header size (magic + version + uuid + name_len = 24)
const INITIAL_READ_SIZE = 4096;

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
  const fmtVersion = data.readUInt16LE(4);
  let pos = 4 + 2 + 16; // magic + version + vault_id
  const nameLen = data.readUInt16LE(pos);
  pos += 2 + nameLen;
  // blob_size(8) + blob_hash(32) + N(2) + K(2) + idx(2) + ver(4) + encrypted(1) = 51
  pos += 51;
  const encrypted = data.readUInt8(pos - 1) !== 0;
  if (encrypted) pos += SALT_SIZE;
  if (fmtVersion >= FORMAT_VERSION_2) pos += 4; // rs_stripe_size
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
function serializeHeader(
  header: ShardHeader,
  encryptionKey?: Buffer,
  fmtVersion: number = FORMAT_VERSION_1,
): Buffer {
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
  const v3FieldsSize = fmtVersion >= FORMAT_VERSION_2 ? 4 : 0; // rs_stripe_size
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
    v3FieldsSize + // rs_stripe_size (only format_version >= 3)
    4 +
    locationMapPayload.length; // map_length + map_payload

  const buf = Buffer.alloc(headerSize);
  let pos = 0;

  // Magic: "BFSS"
  buf.write(MAGIC, pos, 'ascii');
  pos += 4;
  // Format version
  buf.writeUInt16LE(fmtVersion, pos);
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

  // RS stripe size (v3+)
  if (fmtVersion >= FORMAT_VERSION_2) {
    buf.writeUInt32LE(header.rs_stripe_size ?? 0, pos);
    pos += 4;
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
  const headerBuf = serializeHeader(header, encryptionKey, FORMAT_VERSION_1);
  const body = Buffer.concat([headerBuf, payload]);
  const checksum = Buffer.from(hashBuffer(body), 'hex');
  return Buffer.concat([body, checksum]);
}

/**
 * Serializes a shard header into a binary Buffer with FORMAT_VERSION=2.
 * Used by buildShardStream for the streaming (large file) pipeline.
 * FORMAT_VERSION=2 shards have layout: [header][encrypted_payload][GCM tag 16B][SHA-256 32B]
 *
 * @param header        - Shard metadata including location map
 * @param encryptionKey - 32-byte key to encrypt the location map (when header.encrypted=true)
 * @returns Serialized v2 header Buffer
 */
export function serializeShardHeader(
  header: ShardHeader,
  encryptionKey?: Buffer,
): Buffer {
  return serializeHeader(header, encryptionKey, FORMAT_VERSION_2);
}

/**
 * Builds a shard Readable stream from a pre-serialized v2 header and a payload stream.
 * Output layout: [header bytes][payload chunks...][SHA-256 checksum 32B]
 * The SHA-256 is computed incrementally over header+payload and appended at the end.
 * Compatible with parseShardHeaderFromStream for FORMAT_VERSION=2 shards.
 *
 * @param serializedHeader - Output of serializeShardHeader()
 * @param payloadStream    - Readable of the payload (encrypted_payload + GCM tag for v2)
 * @returns Readable stream of the complete shard
 */
export function buildShardStream(
  serializedHeader: Buffer,
  payloadStream: Readable,
): Readable {
  const hasher = createHash('sha256');
  hasher.update(serializedHeader); // hash starts with header bytes

  let headerEmitted = false;
  const output = new PassThrough();

  payloadStream.on('error', (err) => output.destroy(err));
  payloadStream.on('data', (chunk: Buffer | Uint8Array) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!headerEmitted) {
      output.write(serializedHeader);
      headerEmitted = true;
    }
    hasher.update(buf);
    output.write(buf);
  });
  payloadStream.on('end', () => {
    if (!headerEmitted) {
      // Edge case: empty payload stream
      output.write(serializedHeader);
    }
    const checksum = hasher.digest();
    output.end(checksum);
  });

  return output;
}

/**
 * Parses the shard header from the start of a Readable stream.
 * Supports FORMAT_VERSION 1 (legacy), 2 (streaming pipeline), and 3 (rs_stripe_size).
 * Returns the parsed header and a payloadStream for the remaining bytes.
 *
 * payloadStream (v1): [RS_payload bytes] — verified against trailing SHA-256
 * payloadStream (v2): [encrypted_payload + GCM tag 16B] — verified against trailing SHA-256
 *
 * @param stream        - Full shard Readable stream
 * @param encryptionKey - 32-byte key to decrypt the location map (optional)
 * @returns header (with location_map=[] if encrypted and no key) and payloadStream
 * @throws ShardCorruptedError if magic is invalid, header is truncated, or checksum fails
 * @throws DecryptionError if map is encrypted but provided key is wrong
 */
export async function parseShardHeaderFromStream(
  stream: Readable,
  encryptionKey?: Buffer,
): Promise<{ header: ShardHeader; payloadStream: Readable }> {
  // ── Step 1: collect initial bytes for header parsing ──────────────────
  const iter = stream[Symbol.asyncIterator]() as AsyncIterator<
    Buffer | Uint8Array
  >;
  const initialChunks: Buffer[] = [];
  let initialSize = 0;

  while (initialSize < INITIAL_READ_SIZE) {
    const { done, value } = await iter.next();
    if (done) break;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    initialChunks.push(chunk);
    initialSize += chunk.length;
  }

  const initial = Buffer.concat(initialChunks);

  if (initial.length < 5) {
    throw new ShardCorruptedError('Shard stream too short to be valid');
  }

  // ── Step 2: verify magic and parse header ─────────────────────────────
  const magic = initial.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(
      `Invalid shard magic: expected "BFSS", got "${magic}"`,
    );
  }

  const headerSize = computeShardHeaderSize(initial);
  if (initial.length < headerSize) {
    throw new ShardCorruptedError(
      'Shard stream too short to contain complete header',
    );
  }

  const common = parseCommonHeaderFields(initial, 4);

  // ── Step 3: parse location map ────────────────────────────────────────
  let locationMap: ShardLocation[] = [];
  if (common.map_length > 0) {
    if (common.encrypted && encryptionKey) {
      const result = readLocationMap(
        initial,
        common.pos,
        common.map_length,
        true,
        encryptionKey,
      );
      locationMap = result.locationMap;
    } else if (!common.encrypted) {
      const result = readLocationMap(
        initial,
        common.pos,
        common.map_length,
        false,
        undefined,
      );
      locationMap = result.locationMap;
    }
    // encrypted && no key → locationMap stays [] (caller decrypts if needed)
  }

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
    rs_stripe_size: common.rs_stripe_size,
    map_length: common.map_length,
    location_map: locationMap,
  };

  // ── Step 4: build payload stream with checksum verification ──────────
  const headerBuf = initial.subarray(0, headerSize);
  const afterHeader = initial.subarray(headerSize); // remaining bytes after header

  const payloadStream = _buildChecksumVerifiedStream(
    iter,
    headerBuf,
    afterHeader,
  );

  return { header, payloadStream };
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

  let rs_stripe_size: Nullable<number> = null;
  if (format_version >= FORMAT_VERSION_2) {
    rs_stripe_size = data.readUInt32LE(pos);
    pos += 4;
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
    rs_stripe_size,
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
 * Builds a payload stream from an iterator + overflow bytes, with checksum verification.
 * Emits all payload bytes EXCEPT the trailing CHECKSUM_SIZE bytes (the SHA-256 checksum).
 * Verifies that SHA-256(headerBuf + emitted payload) matches the stored checksum.
 * Destroys the stream with ShardCorruptedError if verification fails.
 */
function _buildChecksumVerifiedStream(
  iter: AsyncIterator<Buffer | Uint8Array>,
  headerBuf: Buffer,
  afterHeader: Buffer,
): Readable {
  const hasher = createHash('sha256');
  hasher.update(headerBuf); // checksum covers header too
  let tail = Buffer.alloc(0); // rolling last CHECKSUM_SIZE bytes
  const output = new PassThrough();

  void (async () => {
    try {
      // Writes chunk to output with backpressure: waits for 'drain' when buffer is full.
      // Without this, 3 concurrent 20 GB shard streams can exhaust RAM.
      const emitWithBackpressure = async (buf: Buffer) => {
        if (!output.write(buf)) {
          await new Promise<void>((resolve) => output.once('drain', resolve));
        }
      };

      const processChunk = async (chunk: Buffer) => {
        const combined = Buffer.concat([tail, chunk]);
        if (combined.length > CHECKSUM_SIZE) {
          const toEmit = combined.subarray(0, combined.length - CHECKSUM_SIZE);
          hasher.update(toEmit);
          await emitWithBackpressure(toEmit);
          tail = combined.subarray(combined.length - CHECKSUM_SIZE);
        } else {
          tail = combined;
        }
      };

      if (afterHeader.length > 0) await processChunk(afterHeader);

      for (;;) {
        const { done, value } = await iter.next();
        if (done) break;
        await processChunk(Buffer.isBuffer(value) ? value : Buffer.from(value));
      }

      // tail is now the stored checksum (CHECKSUM_SIZE bytes)
      if (tail.length !== CHECKSUM_SIZE) {
        throw new ShardCorruptedError(
          'Shard stream ended before checksum — data is truncated',
        );
      }
      const computed = hasher.digest();
      if (!computed.equals(tail)) {
        throw new ShardCorruptedError(
          'Shard checksum mismatch — data is corrupted or tampered',
        );
      }
      output.push(null);
    } catch (err) {
      output.destroy(
        err instanceof Error ? err : new ShardCorruptedError(String(err)),
      );
    }
  })();

  return output;
}
