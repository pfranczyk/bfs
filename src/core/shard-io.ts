import { createHash } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import type { RemoteRef, ShardHeader, ShardIdentity, ShardLocation, StorageProvider } from '../types/index.js';
import { decryptLocationMap, encryptLocationMap } from './crypto.js';
import { BfsError, DecryptionError, ShardCorruptedError } from './errors.js';
import { hashBuffer, SHA256_BYTES } from './hash.js';

const MAGIC = 'BFSS';
const FORMAT_VERSION_1 = 1;
const FORMAT_VERSION_2 = 2;
const CHECKSUM_SIZE = SHA256_BYTES;
const SALT_SIZE = 16;
// Minimum bytes needed to determine header size (magic + version + uuid + name_len = 24)
const INITIAL_READ_SIZE = 4096;

/**
 * Maximum striped-RS stripe size a V2 shard header may declare (256 MiB).
 * rsDecodeStriped allocates (N+K) × stripe_size on the read path, so a crafted
 * header carrying a multi-GiB stripe would drive an OOM during pull/recovery.
 * Push never writes above this cap (push-pipeline imports it); the header parser
 * rejects anything above it — or zero — as a corrupted shard.
 */
export const V2_MAX_STRIPE_SIZE = 256 * 1024 * 1024;

/**
 * Default byte budget for header reads — both the in-shard header (downloadHeader)
 * and the sidecar (downloadHeaderSidecar). A shard header is a few hundred bytes
 * to a few KB; 16 KB is a comfortable bound that avoids pulling the full payload.
 */
export const SHARD_HEADER_READ_BYTES = 16384;

// ─── Sidecar header (BFSH) binary layout ──────────────────────────────────
//
// 0x00   4     Magic: "BFSH" (distinct from the shard magic "BFSS")
// 0x04   4     Format version: uint32 LE (1)
// 0x08   var   Serialized header: output of buildHeaderBytes() — a full shard
//              header (magic … end of location map), without payload or the
//              shard's trailing checksum
// EOF-32 32    SHA-256 of everything above (checksum)
const BFSH_MAGIC = 'BFSH';
const BFSH_FORMAT_VERSION = 1;
const BFSH_PREFIX_SIZE = 8; // magic(4) + format_version(4)

// ─── Shard header size helper ─────────────────────────────────────────────

/**
 * Computes the byte length of the shard header by walking the binary layout
 * without decrypting the location map.
 *
 * Every field offset is bounds-checked against the buffer so that malformed
 * input (e.g. a header claiming a 64 KB vault name) raises a typed
 * ShardCorruptedError instead of a raw RangeError. This matters because the
 * buffer can come from an untrusted external provider via readShardHeader.
 *
 * @param data - Full shard binary buffer (or a header window)
 * @returns Byte offset where the RS payload begins (i.e. header size)
 * @throws ShardCorruptedError if the buffer is too short, the magic is invalid,
 *         or a length field points past the end of the buffer
 */
export function computeShardHeaderSize(data: Buffer): number {
  if (data.length < 27) {
    throw new ShardCorruptedError('Shard buffer too short to determine header size');
  }
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(`Invalid shard magic: "${magic}"`);
  }
  const fmtVersion = data.readUInt16LE(4);
  let pos = 4 + 2 + 16; // magic + version + vault_id
  const nameLen = data.readUInt16LE(pos);
  pos += 2 + nameLen;
  // blob_size(8) + blob_hash(32) + N(2) + K(2) + idx(2) + ver(4) + encrypted(1) = 51
  pos += 51;
  // Bounds: the encrypted flag sits at pos-1. A bogus nameLen blows pos past EOF.
  if (pos > data.length) {
    throw new ShardCorruptedError('Shard header is truncated (fixed fields exceed buffer — likely a bogus name length)');
  }
  const encrypted = data.readUInt8(pos - 1) !== 0;
  if (encrypted) pos += SALT_SIZE;
  if (fmtVersion >= FORMAT_VERSION_2) pos += 4; // rs_stripe_size
  // Bounds: map_length is a uint32 at pos.
  if (pos + 4 > data.length) {
    throw new ShardCorruptedError('Shard header is truncated (location map length field exceeds buffer)');
  }
  const mapLength = data.readUInt32LE(pos);
  pos += 4 + mapLength;
  // Bounds: the location map payload itself must fit. A bogus map_length
  // (e.g. 0x7FFFFFFF) would otherwise return an offset past EOF, and callers
  // doing data.subarray(0, pos) would silently truncate or RangeError instead
  // of seeing a typed corruption error.
  if (pos > data.length) {
    throw new ShardCorruptedError('Shard header is truncated (location map exceeds buffer)');
  }
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
function serializeHeader(header: ShardHeader, encryptionKey?: Buffer, fmtVersion: number = FORMAT_VERSION_1): Buffer {
  const vaultIdBuf = uuidToBuffer(header.vault_id);
  const vaultNameBuf = Buffer.from(header.vault_name, 'utf8');
  const blobHashBuf = Buffer.from(header.blob_hash, 'hex');

  // Build location map payload (encrypted or raw JSON)
  let locationMapPayload: Buffer;
  if (encryptionKey) {
    locationMapPayload = encryptLocationMap(header.location_map, encryptionKey);
  } else {
    locationMapPayload = Buffer.from(JSON.stringify(header.location_map), 'utf8');
  }

  // Compute total header byte count
  const encryptedFieldsSize = header.encrypted ? SALT_SIZE : 0;
  const v2FieldsSize = fmtVersion >= FORMAT_VERSION_2 ? 4 : 0; // rs_stripe_size
  const headerSize =
    4 +
    2 +
    16 + // magic + version + vault_id
    2 +
    vaultNameBuf.length + // name_len + name
    8 +
    SHA256_BYTES +
    2 +
    2 +
    2 +
    4 +
    1 + // blob_size + blob_hash + N + K + idx + ver + encrypted
    encryptedFieldsSize + // kdf_salt (only if encrypted)
    v2FieldsSize + // rs_stripe_size (only format_version >= 2)
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
  pos += SHA256_BYTES;
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
      throw new BfsError('kdf_salt (16 bytes) is required when header.encrypted=true');
    }
    header.kdf_salt.copy(buf, pos);
    pos += SALT_SIZE;
  }

  // RS stripe size (FORMAT_VERSION >= 2)
  if (fmtVersion >= FORMAT_VERSION_2) {
    buf.writeUInt32LE(header.rs_stripe_size ?? 0, pos);
    pos += 4;
  }

  // Location map length + payload
  buf.writeUInt32LE(locationMapPayload.length, pos);
  pos += 4;
  locationMapPayload.copy(buf, pos);
  pos += locationMapPayload.length;

  if (pos !== headerSize) {
    throw new BfsError(`serializeHeader offset mismatch: wrote ${pos} B, expected ${headerSize} B`);
  }

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
export function buildShard(header: ShardHeader, payload: Buffer, encryptionKey?: Buffer): Buffer {
  const headerBuf = serializeHeader(header, encryptionKey, FORMAT_VERSION_1);
  const body = Buffer.concat([headerBuf, payload]);
  const checksum = Buffer.from(hashBuffer(body), 'hex');
  return Buffer.concat([body, checksum]);
}

/**
 * Builds a complete FORMAT_VERSION 2 shard binary from a header and its final
 * stored payload. Layout: [V2 header][payload][SHA-256 checksum] — the same
 * assembly as buildShardStream, in buffer form. The payload must already be in
 * stored form (the encrypted ciphertext+GCM tag for an encrypted vault, or the
 * raw striped RS bytes otherwise); this function does NOT encrypt the payload.
 * Only the location map inside the header is encrypted, via `encryptionKey`.
 *
 * @param header        - Shard metadata including location map (format_version 2)
 * @param payload       - Final stored shard payload (ciphertext+tag, or raw)
 * @param encryptionKey - 32-byte key to encrypt the location map (when header.encrypted=true)
 * @returns Complete V2 shard Buffer ready for storage
 * @throws BfsError if header.encrypted=true but kdf_salt is missing
 */
export function buildShardV2(header: ShardHeader, payload: Buffer, encryptionKey?: Buffer): Buffer {
  const headerBuf = serializeShardHeader(header, encryptionKey);
  const body = Buffer.concat([headerBuf, payload]);
  const checksum = Buffer.from(hashBuffer(body), 'hex');
  return Buffer.concat([body, checksum]);
}

/**
 * Builds the serialized header bytes for a shard with the given location map.
 * Equivalent to a shard with an empty payload, minus the trailing checksum:
 * the result spans from the magic to the end of the location map. This is the
 * exact content stored in a header sidecar (BFSH) and the input expected by
 * StorageProvider.updateShardHeader().
 *
 * @param header        - Shard metadata including the location map
 * @param encryptionKey - 32-byte key to encrypt the location map (when header.encrypted=true)
 * @returns Serialized header Buffer (no payload, no checksum)
 * @throws BfsError if header.encrypted=true but kdf_salt is missing
 */
export function buildHeaderBytes(header: ShardHeader, encryptionKey?: Buffer): Buffer {
  // The serialized header IS the header-bytes form: a shard with an empty
  // payload, minus the trailing checksum, reduces to exactly the header. Going
  // through buildShard() would hash an empty body only to discard the result.
  //
  // Serialize at the shard's ACTUAL format version. Hardcoding V1 here would
  // downgrade a V2 shard's header (dropping rs_stripe_size, flipping
  // format_version to 1) whenever updateShardHeader rewrites it during heal
  // (relocate / rebuild's surviving-shard refresh). A normal pull tolerates that
  // (it reads the stripe size from the local manifest), but disaster recovery
  // rebuilds the manifest FROM the shard header — it would then mis-read a V2
  // shard as legacy V1 and fail to decode the striped, per-shard-encrypted payload.
  return serializeHeader(header, encryptionKey, header.format_version);
}

/**
 * Wraps a shard header in the standard sidecar (BFSH) binary format:
 * [magic "BFSH"][format_version uint32 LE][serializedHeader][SHA-256 checksum].
 * Every provider that keeps the header in a sidecar file stores these exact
 * bytes, regardless of where the file physically lives.
 *
 * @param header        - Shard metadata including the current location map
 * @param encryptionKey - 32-byte key to encrypt the location map (when header.encrypted=true)
 * @returns BFSH sidecar Buffer ready for StorageProvider.uploadHeaderSidecar()
 * @throws BfsError if header.encrypted=true but kdf_salt is missing
 */
export function buildSidecarBytes(header: ShardHeader, encryptionKey?: Buffer): Buffer {
  const headerBytes = buildHeaderBytes(header, encryptionKey);
  const prefix = Buffer.alloc(BFSH_PREFIX_SIZE);
  let offset = 0;
  prefix.write(BFSH_MAGIC, offset, 'ascii');
  offset += 4;
  prefix.writeUInt32LE(BFSH_FORMAT_VERSION, offset);
  offset += 4;
  if (offset !== BFSH_PREFIX_SIZE) {
    throw new BfsError(`buildSidecarBytes prefix offset mismatch: wrote ${offset} B, expected ${BFSH_PREFIX_SIZE} B`);
  }
  const body = Buffer.concat([prefix, headerBytes]);
  const checksum = Buffer.from(hashBuffer(body), 'hex');
  return Buffer.concat([body, checksum]);
}

/**
 * Maps a shard filename to its header-sidecar filename by swapping the leading
 * `shard_` for `hdr_` (e.g. "shard_0.bfs.1" → "hdr_0.bfs.1"). The distinct
 * prefix keeps sidecars out of every `list('shard_')` scan structurally, so no
 * shard version parser ever mistakes a sidecar for a shard.
 *
 * @param shardFilename - Bare shard filename (e.g. "shard_0.bfs.1")
 * @returns The paired sidecar filename
 */
export function sidecarFilename(shardFilename: string): string {
  return shardFilename.replace(/^shard_/, 'hdr_');
}

/**
 * Serializes a shard header into a binary Buffer with FORMAT_VERSION=2.
 * FORMAT_VERSION=2 shards have layout: [header][encrypted_payload][GCM tag 16B][SHA-256 32B]
 *
 * @param header        - Shard metadata including location map
 * @param encryptionKey - 32-byte key to encrypt the location map (when header.encrypted=true)
 * @returns Serialized v2 header Buffer
 */
export function serializeShardHeader(header: ShardHeader, encryptionKey?: Buffer): Buffer {
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
export function buildShardStream(serializedHeader: Buffer, payloadStream: Readable): Readable {
  const hasher = createHash('sha256');
  hasher.update(serializedHeader); // hash starts with header bytes

  let headerEmitted = false;
  const output = new PassThrough();

  // Tear down the payload source when the shard stream is destroyed (e.g. the
  // consumer's upload rejected). A file-backed payload (parity temp) would
  // otherwise keep a pending open and emit a late 'error' with no listener once
  // the temp file is unlinked, surfacing as an unhandled exception.
  output.on('close', () => {
    if (!payloadStream.destroyed) payloadStream.destroy();
  });
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
 * Supports FORMAT_VERSION 1 (legacy) and 2 (streaming pipeline with rs_stripe_size).
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
export async function parseShardHeaderFromStream(stream: Readable, encryptionKey?: Buffer): Promise<{ header: ShardHeader; payloadStream: Readable }> {
  // ── Step 1: collect initial bytes for header parsing ──────────────────
  const iter = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>;
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

  // ── Step 2: verify magic and parse the header ────────────────────────
  // Explicit magic check gives a clearer "expected BFSS, got X" message than
  // the generic one computeShardHeaderSize would raise for the same condition.
  const magic = initial.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(`Invalid shard magic: expected "BFSS", got "${magic}"`);
  }
  const headerSize = computeShardHeaderSize(initial);
  if (initial.length < headerSize) {
    throw new ShardCorruptedError('Shard stream too short to contain complete header');
  }
  const header = buildShardHeaderFromBytes(initial.subarray(0, headerSize), encryptionKey);

  // ── Step 3: build payload stream with checksum verification ──────────
  const headerBuf = initial.subarray(0, headerSize);
  const afterHeader = initial.subarray(headerSize); // remaining bytes after header

  const payloadStream = _buildChecksumVerifiedStream(iter, headerBuf, afterHeader);

  return { header, payloadStream };
}

/**
 * Reads a shard header through the provider, honoring the sidecar contract.
 * When the provider keeps headers in a sidecar (usesSidecar() === true) and a
 * sidecar exists, it is the single source of truth and wins over the in-shard
 * header. Otherwise the header is parsed from the front of the shard.
 *
 * Shared read-path entry point for verify / recovery / heal / repair.
 *
 * @param provider - Provider holding the shard
 * @param ref      - RemoteRef of the shard
 * @param vaultKey - 32-byte key to decrypt the location map (optional)
 * @returns The parsed shard header
 * @throws ShardCorruptedError if a present sidecar has a bad magic/checksum, or
 *         the in-shard header is invalid or truncated
 * @throws DecryptionError if the map is encrypted but the key is wrong
 */
export async function readShardHeader(provider: StorageProvider, ref: RemoteRef, vaultKey?: Buffer): Promise<ShardHeader> {
  // The bytes come back sidecar-aware; parsing is synchronous — the header
  // window has no payload stream to verify or discard.
  return buildShardHeaderFromBytes(await readShardHeaderBytes(provider, ref), vaultKey);
}

/**
 * Fetches the raw serialized header bytes for a shard, honoring the sidecar
 * contract. When the provider keeps headers in a sidecar (usesSidecar() ===
 * true) and one exists, the sidecar's embedded header is returned; otherwise
 * the in-shard header window is read. Returns BYTES rather than a parsed header
 * so a caller that must try several vault keys against the same buffer
 * (recovery's MRU password pool) can re-parse without re-fetching.
 *
 * Every read path that needs the CURRENT location map — recovery, bootstrap,
 * consensus — must go through this, not provider.downloadHeader directly, or it
 * would read a relocated shard's stale in-shard map instead of its sidecar.
 *
 * @param provider - Provider holding the shard
 * @param ref      - RemoteRef of the shard
 * @param maxBytes - Byte budget for the read (in-shard window or sidecar cap)
 * @returns Serialized header bytes (magic … end of location map)
 * @throws ShardCorruptedError if a present sidecar has a bad magic/checksum
 */
export async function readShardHeaderBytes(provider: StorageProvider, ref: RemoteRef, maxBytes = SHARD_HEADER_READ_BYTES): Promise<Buffer> {
  if (provider.usesSidecar()) {
    const sidecar = await provider.downloadHeaderSidecar(ref, maxBytes);
    if (sidecar !== null) return extractSidecarHeaderBytes(sidecar);
  }
  return provider.downloadHeader(ref, maxBytes);
}

/**
 * Compares a parsed header against an expected identity (vault_id, shard_index,
 * version). Returns the first mismatching field (with stringified values) or
 * null when all three match. Shared by StorageProvider.verifyShard()
 * implementations so the comparison stays identical across providers.
 *
 * @param header   - Parsed shard header
 * @param expected - Identity the shard is expected to carry
 * @returns The first mismatch { field, expected, actual } or null when identical
 */
export function matchShardIdentity(header: ShardHeader, expected: ShardIdentity): Nullable<{ field: string; expected: string; actual: string }> {
  if (header.vault_id !== expected.vault_id) {
    return { field: 'vault_id', expected: expected.vault_id, actual: header.vault_id };
  }
  if (header.shard_index !== expected.shard_index) {
    return { field: 'shard_index', expected: String(expected.shard_index), actual: String(header.shard_index) };
  }
  if (header.version !== expected.version) {
    return { field: 'version', expected: String(expected.version), actual: String(header.version) };
  }
  return null;
}

/**
 * Validates a sidecar (BFSH) buffer and returns the serialized header bytes it
 * carries. Checks the magic first, then the trailing SHA-256 checksum, then
 * strips the 8-byte BFSH prefix and 32-byte checksum to yield exactly the
 * embedded shard-header bytes (magic … end of location map). Returns bytes, not
 * a parsed header, so callers can re-parse the same buffer with different vault
 * keys (recovery's MRU password pool).
 *
 * @param sidecar - Raw BFSH bytes from downloadHeaderSidecar()
 * @returns The embedded serialized shard-header bytes
 * @throws ShardCorruptedError on bad magic or checksum mismatch
 */
export function extractSidecarHeaderBytes(sidecar: Buffer): Buffer {
  if (sidecar.length < BFSH_PREFIX_SIZE + CHECKSUM_SIZE) {
    throw new ShardCorruptedError('Sidecar too short to contain a valid BFSH header');
  }
  const magic = sidecar.subarray(0, 4).toString('ascii');
  if (magic !== BFSH_MAGIC) {
    throw new ShardCorruptedError(`Invalid sidecar magic: expected "${BFSH_MAGIC}", got "${magic}"`);
  }
  const body = sidecar.subarray(0, sidecar.length - CHECKSUM_SIZE);
  const storedChecksum = sidecar.subarray(sidecar.length - CHECKSUM_SIZE);
  const computed = Buffer.from(hashBuffer(body), 'hex');
  if (!computed.equals(storedChecksum)) {
    throw new ShardCorruptedError('Sidecar checksum mismatch — file is corrupted or tampered');
  }
  return sidecar.subarray(BFSH_PREFIX_SIZE, sidecar.length - CHECKSUM_SIZE);
}

// ─── Private parsing helpers ──────────────────────────────────────────────

/**
 * Parses a complete shard header buffer (magic … end of location map, no
 * payload, no checksum) into a ShardHeader.
 *
 * @param data          - Buffer containing exactly the serialized header
 * @param encryptionKey - 32-byte key to decrypt the location map (optional)
 * @returns The parsed header (location_map=[] if encrypted and no key)
 * @throws ShardCorruptedError if magic is invalid or the buffer is truncated
 * @throws DecryptionError if the map is encrypted but the key is wrong
 */
export function buildShardHeaderFromBytes(data: Buffer, encryptionKey?: Buffer): ShardHeader {
  if (data.length < 5) {
    throw new ShardCorruptedError('Shard header too short to be valid');
  }
  const magic = data.subarray(0, 4).toString('ascii');
  if (magic !== MAGIC) {
    throw new ShardCorruptedError(`Invalid shard magic: expected "BFSS", got "${magic}"`);
  }
  const headerSize = computeShardHeaderSize(data);
  if (data.length < headerSize) {
    throw new ShardCorruptedError('Shard header is truncated');
  }

  const common = parseCommonHeaderFields(data, 4);

  let locationMap: ShardLocation[] = [];
  if (common.map_length > 0) {
    if (common.encrypted && encryptionKey) {
      locationMap = readLocationMap(data, common.pos, common.map_length, true, encryptionKey).locationMap;
    } else if (!common.encrypted) {
      locationMap = readLocationMap(data, common.pos, common.map_length, false, undefined).locationMap;
    }
    // encrypted && no key → locationMap stays [] (caller decrypts if needed)
  }

  return {
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
}

/**
 * Reads all common shard header fields starting at startPos (i.e. after the 4-byte magic).
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
  const blob_hash = data.subarray(pos, pos + SHA256_BYTES).toString('hex');
  pos += SHA256_BYTES;

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
    // Clamp the untrusted stripe size before it feeds rsDecodeStriped's
    // (N+K) × stripe_size allocation. Zero is invalid; anything above the cap
    // push enforces is a crafted/corrupted header, not a recoverable shard.
    if (rs_stripe_size === 0 || rs_stripe_size > V2_MAX_STRIPE_SIZE) {
      throw new ShardCorruptedError(`rs_stripe_size ${rs_stripe_size} is out of range (1..${V2_MAX_STRIPE_SIZE})`);
    }
  }

  const map_length = data.readUInt32LE(pos);
  pos += 4;

  return { format_version, vault_id, vault_name, blob_size, blob_hash, data_shards, parity_shards, shard_index, version, encrypted, kdf_salt, rs_stripe_size, map_length, pos };
}

/**
 * Reads and decodes the location map bytes starting at pos.
 * Decrypts when encrypted=true; parses raw JSON otherwise.
 * Returns the decoded map and the buffer position after the map payload.
 */
function readLocationMap(data: Buffer, pos: number, mapLength: number, encrypted: boolean, encryptionKey: Buffer | undefined): { locationMap: ShardLocation[]; endPos: number } {
  const mapPayload = data.subarray(pos, pos + mapLength);
  const endPos = pos + mapLength;

  if (encrypted) {
    if (!encryptionKey) {
      throw new DecryptionError('This shard is encrypted — provide the encryption key (derive it from the password and kdf_salt)');
    }
    return { locationMap: decryptLocationMap(mapPayload, encryptionKey), endPos };
  }

  try {
    const parsed = JSON.parse(mapPayload.toString('utf8')) as ShardLocation[];
    // Backward compat: older shards omit fields added later. adapterPackage
    // undefined → null (legacy shards come from built-in providers). required_inputs
    // undefined → null marks a legacy shard whose secret is still inline in
    // connection_config, so recovery uses it directly instead of prompting.
    // Keep this the ONLY normalization point for plain (unencrypted) location
    // maps; see architecture/binary-format.md.
    const locationMap = parsed.map((loc) => ({ ...loc, adapterPackage: loc.adapterPackage ?? null, required_inputs: loc.required_inputs ?? null }));
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
function _buildChecksumVerifiedStream(iter: AsyncIterator<Buffer | Uint8Array>, headerBuf: Buffer, afterHeader: Buffer): Readable {
  const hasher = createHash('sha256');
  hasher.update(headerBuf); // checksum covers header too
  let tail = Buffer.alloc(0); // rolling last CHECKSUM_SIZE bytes
  let totalBytes = headerBuf.length; // cumulative shard size (header + everything we consume from iter)
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
        totalBytes += chunk.length;
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
        throw new ShardCorruptedError(`Shard stream ended before checksum — data is truncated (read ${totalBytes} B, ` + `expected at least header + ${CHECKSUM_SIZE} B trailer)`);
      }
      const computed = hasher.digest();
      if (!computed.equals(tail)) {
        const expectedPrefix = tail.toString('hex').slice(0, 16);
        const computedPrefix = computed.toString('hex').slice(0, 16);
        throw new ShardCorruptedError(
          `Shard checksum mismatch — data is corrupted or tampered ` +
            `(expected ${expectedPrefix}…, computed ${computedPrefix}…, ` +
            `shard size ${totalBytes} B). Compare shard sizes across providers ` +
            'to spot transport-level truncation.',
        );
      }
      output.push(null);
    } catch (err) {
      output.destroy(err instanceof Error ? err : new ShardCorruptedError(String(err)));
    }
  })();

  return output;
}
