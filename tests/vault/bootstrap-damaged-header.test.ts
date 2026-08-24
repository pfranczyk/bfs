import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { deriveKey } from '../../src/core/crypto.js';
import { ProviderError } from '../../src/core/errors.js';
import { buildShardV2, buildSidecarBytes, SHARD_HEADER_READ_BYTES } from '../../src/core/shard-io.js';
import { fmtFor, setLang } from '../../src/i18n/index.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { bootstrapFromProvider } from '../../src/vault/bootstrap.js';

// --- Contract under test ----------------------------------------------------
//
// A bootstrap provider whose copy of the backup does not check out must be
// reported as such, with the way out named - never as a password problem, and
// never as a raw internal parser literal.
//
// bootstrapFromProvider (src/vault/bootstrap.ts) reads only the header window
// (readShardHeaderBytes in src/core/shard-io.ts) and destroys the
// checksum-verified payload stream, so the shard's trailing SHA-256 is not
// available there. Every way a header can rot - the Argon2id salt, the sealed
// map, the sidecar that supersedes both - surfaces as "the key does not open the
// map", which is also exactly what a wrong password looks like. Only the
// checksum separates them, and it is taken ONLY once an attempt to open the map
// has already failed:
//
//   map opened            -> nothing else happens, no extra read
//   map failed, sum ok    -> the password really is wrong -> keep prompting
//   map failed, sum wrong -> this copy does not check out -> refuse, name the way out
//
// Taking it earlier would put a full shard read in front of every interactive
// recovery of an encrypted backup, against the closed decision "verification on
// demand - opt-in, default shallow", and would condemn a shard whose payload
// rotted while its header is intact: recovery reads headers only, and RS repairs
// that payload at pull time.
//
// The checksum covers the header together with the payload, so it cannot say
// WHICH of them rotted - and when a rotted payload coincides with a wrong
// password it cannot even say the medium is at fault alone. The refusal
// therefore claims neither: it reports that this copy does not check out and
// sends the operator to a sibling, which is the right move under every reading
// (a wrong password announces itself as such there).
//
// The copy is never at risk - every sibling carries the version's real salt and
// the same map (proved end-to-end by 49c-recovery-bootstrap-damaged-header and
// 49d-recovery-bootstrap-damaged-header-noenc).
//
// Payloads here exceed SHARD_HEADER_READ_BYTES so that the header window and the
// whole shard are different byte ranges: a check that reads only the window it
// already holds must not be able to satisfy these tests.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VAULT_NAME = 'bootstrap-damaged';
const PASSWORD = 'correct-horse-battery';
const WRONG_PASSWORD = 'not-the-password';
const BOOTSTRAP_ID = 'bootstrap';
const MOCK_TYPE = 'mock-damaged-header';
const PAYLOAD_SIZE = SHARD_HEADER_READ_BYTES * 2;

/** Where bit-rot lands. `map` hits the GCM tag sealing the location map. */
type Damage = 'none' | 'salt' | 'map' | 'payload';

/** Registers the provider type named by the location map entries. */
function registerMockProvider(): void {
  providerRegistry.register(MOCK_TYPE, {
    lang: 'en',
    displayName: 'Mock',
    create: (config: ProviderConfig): StorageProvider =>
      ({
        id: config.id,
        type: MOCK_TYPE,
        authenticate: vi.fn().mockResolvedValue(undefined),
        setVaultName: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
        downloadHeader: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        getSecretFields: vi.fn().mockReturnValue([]),
        describeConfig: vi.fn().mockReturnValue(''),
        healthCheck: vi.fn().mockResolvedValue(true),
        usesSidecar: vi.fn().mockReturnValue(false),
        uploadHeaderSidecar: vi.fn(),
        downloadHeaderSidecar: vi.fn().mockResolvedValue(null),
        verifyShard: vi.fn().mockResolvedValue({ ok: true }),
      }) as unknown as StorageProvider,
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterMockProvider(): void {
  const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
  entries.delete(MOCK_TYPE);
}

/** A 2/1 version's three entries - the shape a real backup of this scheme has. */
function locationMap(): ShardLocation[] {
  return [BOOTSTRAP_ID, 'p1', 'p2'].map((id, index) => ({
    shard_index: index,
    provider_id: id,
    provider_type: MOCK_TYPE,
    adapterPackage: null,
    connection_config: {},
    required_inputs: [],
    remote_path: `${VAULT_NAME}/shard_${index}.bfs.1`,
    shard_hash: 'a'.repeat(64),
  }));
}

/** Flips one bit at the given offset - bit-rot, with no checksum recomputed. */
function flipByteAt(shard: Buffer, at: number): void {
  const byte = shard[at];
  assert(byte !== undefined, 'the byte to flip must lie inside the shard buffer');
  shard[at] = byte ^ 0x01;
}

/** Builds the header a version-1 shard of this backup carries. */
function shardHeader(salt: Buffer): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 2,
    vault_id: VAULT_ID,
    vault_name: VAULT_NAME,
    blob_size: BigInt(PAYLOAD_SIZE * 2),
    blob_hash: 'b'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: true,
    kdf_salt: salt,
    rs_stripe_size: 65536,
    map_length: 0,
    location_map: locationMap(),
  };
}

/**
 * Builds a real encrypted V2 shard (header + payload + trailing SHA-256) and
 * rots one byte of it, as a failing medium would: nothing is re-sealed, so the
 * trailing checksum stops matching in every damaged variant.
 *
 * `salt` hits the Argon2id salt, so the key derived from the correct password no
 * longer opens the map. `map` hits the last byte of the sealed map - the tail of
 * its GCM tag - so no key opens it at all. Both leave the header parsable and
 * are indistinguishable from a wrong password without the checksum. `payload`
 * leaves the header, and therefore the map, perfectly readable.
 */
async function buildShardBytes(damage: Damage): Promise<Buffer> {
  const salt = randomBytes(16);
  const encKey = await deriveKey(PASSWORD, salt);
  const header = shardHeader(salt);
  const headerBytes = buildSidecarBytes(header, encKey);
  const shard = buildShardV2(header, randomBytes(PAYLOAD_SIZE), encKey);

  switch (damage) {
    case 'none':
      return shard;
    case 'salt': {
      // The salt is stored verbatim, so locating it by value needs no offset
      // arithmetic that could drift with the format.
      const at = shard.indexOf(salt);
      expect(at).toBeGreaterThan(0);
      flipByteAt(shard, at);
      return shard;
    }
    case 'map': {
      // The sidecar form ends exactly at the end of the location map, so its
      // length locates the map's last byte inside the shard without duplicating
      // the header layout here.
      const mapEnd = headerBytes.length - 32 - 8;
      flipByteAt(shard, mapEnd - 1);
      return shard;
    }
    default:
      // Well past the header window and clear of the trailing checksum.
      flipByteAt(shard, shard.length - 64);
      return shard;
  }
}

/** Options for {@link bootstrapProvider}. */
interface ProviderOptions {
  /** Serve the header from an `hdr_` sidecar, as both built-in providers do. */
  sidecar?: Buffer;
  /** Fail every full-shard read with this error (transport fault injection). */
  downloadError?: Error;
}

/** A bootstrap provider serving exactly that one shard. */
function bootstrapProvider(shard: Buffer, options: ProviderOptions = {}): StorageProvider {
  const { sidecar, downloadError } = options;
  return {
    id: BOOTSTRAP_ID,
    type: MOCK_TYPE,
    authenticate: vi.fn().mockResolvedValue(undefined),
    setVaultName: vi.fn(),
    list: vi.fn().mockResolvedValue([{ provider_id: BOOTSTRAP_ID, path: 'shard_0.bfs.1' } satisfies RemoteRef]),
    download: vi.fn().mockImplementation(async () => {
      if (downloadError) throw downloadError;
      return Readable.from(shard);
    }),
    downloadHeader: vi.fn().mockImplementation(async (_ref: RemoteRef, maxBytes: number) => shard.subarray(0, Math.min(maxBytes, shard.length))),
    usesSidecar: vi.fn().mockReturnValue(sidecar !== undefined),
    uploadHeaderSidecar: vi.fn(),
    downloadHeaderSidecar: vi.fn().mockResolvedValue(sidecar ?? null),
    verifyShard: vi.fn().mockResolvedValue({ ok: true }),
    getSize: vi.fn().mockResolvedValue(shard.length),
    healthCheck: vi.fn().mockResolvedValue(true),
    getSecretFields: vi.fn().mockReturnValue([]),
    describeConfig: vi.fn().mockReturnValue(''),
  } as unknown as StorageProvider;
}

/** Runs a bootstrap and returns whatever it threw. */
async function bootstrapError(provider: StorageProvider, options: { io: ReturnType<typeof createMockProviderIO>['io']; passwords?: string[] }): Promise<Error> {
  const err = await bootstrapFromProvider(provider, { vaultName: VAULT_NAME, io: options.io, ...(options.passwords ? { passwords: options.passwords } : {}) }).catch((e: unknown) => e);
  assert(err instanceof Error, 'the bootstrap was expected to fail');
  return err;
}

describe('bootstrapFromProvider when the bootstrap copy does not check out', () => {
  afterEach(() => {
    unregisterMockProvider();
    vi.restoreAllMocks();
    setLang('en');
  });

  it('should refuse instead of re-asking for the password it already holds', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('salt');
    const { io } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');

    const err = await bootstrapError(bootstrapProvider(shard), { io, passwords: [PASSWORD] });

    // Asking for a password that cannot work is the defect itself, so its
    // absence is asserted on top of the message - a revert brings it back.
    expect(err.message).toContain('on this provider failed its integrity check');
    expect(askSecret).not.toHaveBeenCalled();
  });

  it('should name the way out, not just the fault', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('salt');
    const { io } = createMockProviderIO({});

    const err = await bootstrapError(bootstrapProvider(shard), { io, passwords: [PASSWORD] });

    // A refusal that stops at the diagnosis leaves the operator with a readable
    // dead end; the siblings hold the same map, so it must send them there.
    expect(err.message).toContain('Recover from a different provider');
  });

  it('should refuse the same way when the sealed map itself rotted', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('map');
    const { io } = createMockProviderIO({});

    const err = await bootstrapError(bootstrapProvider(shard), { io, passwords: [PASSWORD] });

    // A check that compares this shard's salt against a sibling's would answer
    // the salt case and leave this one looping forever - the map's own GCM tag
    // is what broke, and every key fails against it.
    expect(err.message).toContain('on this provider failed its integrity check');
  });

  it('should refuse the same way when the header comes from a rotted sidecar', async () => {
    registerMockProvider();
    const salt = randomBytes(16);
    const encKey = await deriveKey(PASSWORD, salt);
    const sidecar = buildSidecarBytes(shardHeader(salt), encKey);
    flipByteAt(sidecar, sidecar.length - 40);
    const { io } = createMockProviderIO({});

    const err = await bootstrapError(bootstrapProvider(await buildShardBytes('none'), { sidecar }), { io, passwords: [PASSWORD] });

    // Both built-in providers keep relocated headers in an `hdr_` sidecar, which
    // wins on the read path, so this is the header the operator's recovery
    // actually used. Its own raw parser message is no more actionable here.
    expect(err.message).toContain('on this provider failed its integrity check');
    expect(err.message).not.toContain('Sidecar checksum mismatch');
  });

  it('should stop after a single prompt when no password was supplied up front', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('salt');
    // The operator recovering on a fresh machine passes no --password and types
    // the CORRECT one at the prompt. One attempt is what licenses the checksum
    // read; a second prompt means the loop is back.
    const { io } = createMockProviderIO({ [fmtFor('en', 'bootstrap_ask_password', '1')]: PASSWORD });
    const askSecret = vi.spyOn(io, 'askSecret');

    const err = await bootstrapError(bootstrapProvider(shard), { io });

    expect(err.message).toContain('on this provider failed its integrity check');
    expect(askSecret).toHaveBeenCalledTimes(1);
  });

  it('should localize the whole refusal, cause and way out alike', async () => {
    registerMockProvider();
    setLang('pl');
    const shard = await buildShardBytes('salt');
    const { io } = createMockProviderIO({});

    const err = await bootstrapError(bootstrapProvider(shard), { io, passwords: [PASSWORD] });

    // The message reaches the operator through error(err.message) in
    // src/cli/commands/recovery.ts, so both halves are translated. Pinning them stops
    // a fix that translates the first sentence and leaves the advice in English.
    expect(err.message).toContain('nie przechodzą kontroli integralności');
    expect(err.message).toContain('Odzyskaj z innego nośnika');
  });

  it('should keep calling a wrong password wrong, on a healthy shard', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('none');
    const { io } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');
    const provider = bootstrapProvider(shard);

    const err = await bootstrapError(provider, { io, passwords: [WRONG_PASSWORD] });

    // The shard is intact, so the map failing to open means exactly what it says.
    // Blaming the medium here would send an operator with a typo to a different
    // provider - where the same typo waits for them.
    expect(err.message).not.toContain('integrity check');
    expect(askSecret).toHaveBeenCalled();
  });

  it('should read the shard at most once however many passwords are tried', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('none');
    const { io } = createMockProviderIO({});
    // Two supplied candidates and three more typed at the prompt: the retry loop
    // is driven per call, which the answers map cannot express.
    vi.spyOn(io, 'askSecret').mockResolvedValueOnce('typo-one').mockResolvedValueOnce('typo-two').mockResolvedValueOnce('typo-three').mockResolvedValue('');
    const provider = bootstrapProvider(shard);

    await bootstrapError(provider, { io, passwords: [WRONG_PASSWORD, 'also-wrong'] });

    // Whether the copy checks out is a property of the bytes, not of the attempt,
    // so it is established once and reused. Re-reading per attempt would charge a
    // handful of typos a handful of full shard transfers over FTP or SSH; exactly
    // one also pins that the check happens at all.
    expect(provider.download).toHaveBeenCalledTimes(1);
  });

  it('should not blame the medium when the verifying read itself fails', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('salt');
    const { io } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');
    const provider = bootstrapProvider(shard, { downloadError: new ProviderError('ECONNRESET while reading shard_0.bfs.1') });

    const err = await bootstrapError(provider, { io, passwords: [PASSWORD] });

    // A read that broke for any other reason says nothing about the bytes. Only
    // a checksum that verifiably fails condemns a medium - a catch-all here
    // would report a healthy provider as damaged after a dropped connection.
    expect(err.message).not.toContain('failed its integrity check');
    // Nor may it end the recovery. The read is diagnostic; when it cannot answer,
    // the run carries on exactly as it did before there was a check at all -
    // otherwise a dropped transfer turns a healthy backup into a failed restore.
    expect(askSecret).toHaveBeenCalled();
  });

  it('should still prompt for a password on a healthy shard when none was supplied', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('none');
    const { io } = createMockProviderIO({ [fmtFor('en', 'bootstrap_ask_password', '1')]: PASSWORD });
    const provider = bootstrapProvider(shard);

    const result = await bootstrapFromProvider(provider, { vaultName: VAULT_NAME, io });

    // Refusing outright whenever the candidate list is empty would break every
    // interactive recovery of an encrypted backup.
    expect(result.vault_id).toBe(VAULT_ID);
    // Nor may the empty candidate list itself trigger the read: with no attempt
    // spent there is nothing to tell apart, and this is the ordinary way an
    // operator recovers on a fresh machine.
    expect(provider.download).not.toHaveBeenCalled();
  });

  it('should accept a shard whose payload rotted but whose header is intact', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('payload');
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(bootstrapProvider(shard), { vaultName: VAULT_NAME, io, passwords: [PASSWORD] });

    // Recovery reads headers, never payloads - RS repairs this payload at pull
    // time. Its trailing checksum is broken all the same, so a check taken before
    // the map is tried would throw away a perfectly usable bootstrap source.
    expect(result.vault_id).toBe(VAULT_ID);
  });

  it('should give the same refusal when a rotted payload and a wrong password coincide', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('payload');
    const { io } = createMockProviderIO({});

    const err = await bootstrapError(bootstrapProvider(shard), { io, passwords: [WRONG_PASSWORD] });

    // Two independent faults the trailing checksum cannot separate. The refusal
    // names neither, and the advice holds either way: on the next provider a
    // wrong password announces itself as such.
    expect(err.message).toContain('on this provider failed its integrity check');
  });

  it('should read neither the shard nor more than the header window when the map opens', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('none');
    const { io } = createMockProviderIO({});
    const provider = bootstrapProvider(shard);

    const result = await bootstrapFromProvider(provider, { vaultName: VAULT_NAME, io, passwords: [PASSWORD] });

    // The closed decision "verification on demand - opt-in, default shallow"
    // keeps full payload transfers off the healthy path; on FTP/SSH this is real
    // bandwidth on every recovery. Widening the header budget is the same
    // transfer by another route, so the budget is pinned too.
    expect(result.vault_id).toBe(VAULT_ID);
    expect(provider.download).not.toHaveBeenCalled();
    for (const call of vi.mocked(provider.downloadHeader).mock.calls) {
      expect(call[1]).toBeLessThanOrEqual(SHARD_HEADER_READ_BYTES);
    }
  });

  it('should bootstrap normally when the shard is undamaged', async () => {
    registerMockProvider();
    const shard = await buildShardBytes('none');
    const { io } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');

    const result = await bootstrapFromProvider(bootstrapProvider(shard), { vaultName: VAULT_NAME, io, passwords: [PASSWORD] });

    expect(result.vault_id).toBe(VAULT_ID);
    expect(result.providers).toHaveLength(3);
    expect(askSecret).not.toHaveBeenCalled();
  });
});
