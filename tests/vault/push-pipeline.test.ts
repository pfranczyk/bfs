import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError, PushDriftError } from '../../src/core/errors.js';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { CatalogDrift, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig } from '../../src/vault/config.js';
import { _computeRamThreshold, _computeStripeSize, _handleCatalogDrift } from '../../src/vault/push-pipeline.js';
import { recover } from '../../src/vault/recovery.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';
import { registerSecretProvider, SecretLocalProvider, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

// Hoisted mid-pack mutation target. When armed, the mocked fs.readFile below
// performs a real on-disk rewrite of `mutateFile` the moment `triggerFile` is
// read during packing - reproducing an external process changing a file inside
// the pack window, so snapshotAfter diverges from snapshotBefore (drift).
// Null = pure call-through, so every other test in this file sees the real fs.
const midPack = vi.hoisted(() => ({ target: null as Nullable<{ triggerFile: string; mutateFile: string; mutateContent: Buffer }> }));

// Mock at the module boundary so the whole push pipeline shares one mocked
// module. Only readFile is overridden; default behaviour is a faithful
// call-through, and the rewrite fires solely for an armed target. Both the
// named and default exports are patched so `import fs from 'node:fs/promises'`
// and `import * as fs` observe the same override.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (p: unknown, options: unknown) => {
    const t = midPack.target;
    if (t && typeof p === 'string' && p === t.triggerFile) {
      await actual.writeFile(t.mutateFile, t.mutateContent); // real writeFile - bypasses the mock
    }
    return actual.readFile(p as never, options as never);
  }) as typeof actual.readFile;
  const patched = { ...actual, readFile };
  return { ...patched, default: patched };
});

beforeEach(() => {
  registerSecretProvider();
});

afterEach(() => {
  unregisterSecretProvider();
  // Spies here reach process-wide builtins (os.totalmem for the RAM budget), and
  // this file's convention is to append at the end - so a spy left standing
  // would silently pin memory for whatever is added next. Touches vi.spyOn only,
  // never the hoisted node:fs/promises module mock above.
  vi.restoreAllMocks();
});

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-strip-'));
}

const secretProvider = secretProviderConfig;

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

describe('push location map secret stripping', () => {
  it('should strip the provider secret from the shard location map but keep it in config.json', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    await push(root, { io: mockIO() });

    // The embedded location map (plaintext, vault is unencrypted) must NOT
    // carry the password, but must keep the non-secret coordinates.
    const shardBytes = await fs.readFile(path.join(dirs[0] ?? '', 'strip', 'shard_0.bfs.1'));
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBytes));
    payloadStream.on('error', () => {}).destroy();

    expect(header.location_map).toHaveLength(3);
    for (const loc of header.location_map) {
      expect(loc.connection_config.password).toBeUndefined();
      expect(loc.connection_config.path).toBeDefined();
      expect(loc.required_inputs).toEqual(['password']);
    }

    // config.json keeps the secret locally (protected by 0600 from K1).
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['pw-p0', 'pw-p1', 'pw-p2']);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push unencrypted warning', () => {
  it('should warn that the backup is not encrypted on every unencrypted push', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');

    await init(root, {
      vault_name: 'plain',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const { io, logs } = createMockProviderIO();
    await push(root, { io });

    expect(logs.some((l) => l.level === 'warn' && /NOT encrypted/.test(l.message))).toBe(true);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('recovery with a stripped location map', () => {
  async function setupStrippedVault(root: string, dirs: string[], io: ProviderIO): Promise<void> {
    await fs.writeFile(path.join(root, 'hello.txt'), 'hello world', 'utf-8');
    await init(root, {
      vault_name: 'strip',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => secretProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await push(root, { io });
    // Disaster: lose the local vault metadata. The remote shards carry a
    // stripped map, so recovery must obtain each provider's transport secret.
    await fs.rm(path.join(root, '.bfs'), { recursive: true });
  }

  it('should reuse the bootstrap secret for sibling providers without prompting', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No interactive answers: every provider must connect from the seeded pool.
    const { io } = createMockProviderIO();
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io, bootstrapInputs: { password: 'shared-key' } });

    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.config.password)).toEqual(['shared-key', 'shared-key', 'shared-key']);
    expect(config?.providers.map((p) => p.config.path)).toEqual(dirs);

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should prompt for a missing secret, pool it for the next provider, and degrade the unanswered one', async () => {
    const root = await tmp();
    const dirs = [await tmp(), await tmp(), await tmp()];
    await setupStrippedVault(root, dirs, mockIO());

    // No seed; only p1 has an answer. p2 must reuse it from the pool (one
    // prompt), and p0 (no answer) degrades to an absent secret in config.json.
    const answers: Record<string, string> = { [fmt('recovery_ask_transport_password', 'password', 'p1')]: 'typed-key' };
    const { io } = createMockProviderIO(answers);
    const bootstrapProvider = new SecretLocalProvider(secretProvider('p0', dirs[0] ?? ''), io);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'strip', provider: bootstrapProvider, io });

    const config = await readConfig(root);
    const passwordById = new Map(config?.providers.map((p) => [p.id, p.config.password]));
    expect(passwordById.get('p0')).toBeUndefined();
    expect(passwordById.get('p1')).toBe('typed-key');
    expect(passwordById.get('p2')).toBe('typed-key');

    await fs.rm(root, { recursive: true, force: true });
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });
});

describe('push catalog drift verification', () => {
  /** Inline ProviderIO with a fixed confirm answer and a warn collector. */
  function driftIO(confirmAnswer: boolean, warns: string[]): ProviderIO {
    return {
      lang: 'en',
      workDir: process.cwd(),
      ask: async () => '',
      askSecret: async () => '',
      confirm: async () => confirmAnswer,
      choose: async () => '',
      info: () => {},
      debug: () => {},
      warn: (message: string) => {
        warns.push(message);
      },
      progress: () => {},
    };
  }

  const realDrift: CatalogDrift = { changed: ['data.bin'], vanished: [], appeared: [] };
  const noDrift: CatalogDrift = { changed: [], vanished: [], appeared: [] };

  describe('_handleCatalogDrift decision gate', () => {
    it('should resolve and emit no warning when there is no drift', async () => {
      const warns: string[] = [];

      await _handleCatalogDrift({ drift: noDrift, io: driftIO(true, warns) });

      expect(warns).toEqual([]);
    });

    it('should accept drift and warn when allowDrift is true', async () => {
      const warns: string[] = [];

      await _handleCatalogDrift({ drift: realDrift, allowDrift: true, io: driftIO(false, warns) });

      expect(warns.length).toBeGreaterThanOrEqual(1);
    });

    it('should resolve when interactive and the user confirms', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, interactive: true, io: driftIO(true, warns) })).resolves.toBeUndefined();
    });

    it('should reject with BfsError when interactive and the user declines', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, interactive: true, io: driftIO(false, warns) })).rejects.toThrow(BfsError);
    });

    it('should reject with PushDriftError when non-interactive and drift is not allowed', async () => {
      const warns: string[] = [];

      await expect(_handleCatalogDrift({ drift: realDrift, io: driftIO(false, warns) })).rejects.toThrow(PushDriftError);
    });
  });

  // End-to-end proof: a source file changes inside the pack window (mtime + size),
  // so snapshotAfter diverges from snapshotBefore. The mocked fs.readFile rewrites
  // `a-first.bin` the instant `z-last.bin` is read during packing - the earlier
  // file's blob bytes are already captured, matching a real mid-push mutation.
  describe('end-to-end mid-pack drift', () => {
    async function tmpDir(): Promise<string> {
      return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-drift-'));
    }

    async function initVault(root: string, dirs: string[]): Promise<void> {
      await init(root, {
        vault_name: 'drift',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: dirs.map((d, i) => secretProviderConfig(`p${i}`, d)),
        push_mode: PushMode.NewVersion,
        io: createMockProviderIO().io,
      });
    }

    afterEach(() => {
      midPack.target = null;
    });

    it('should reject a non-interactive push when a file drifts mid-pack', async () => {
      const root = await tmpDir();
      const dirs = [await tmpDir(), await tmpDir(), await tmpDir()];
      const firstAbs = path.join(root, 'a-first.bin');
      const lastAbs = path.join(root, 'z-last.bin');
      await fs.writeFile(firstAbs, Buffer.alloc(256, 0xaa));
      await fs.writeFile(lastAbs, Buffer.alloc(256, 0xbb));
      await initVault(root, dirs);

      // Grow a-first.bin (size + mtime change) while z-last.bin is being packed.
      midPack.target = { triggerFile: lastAbs, mutateFile: firstAbs, mutateContent: Buffer.alloc(512, 0xcc) };
      try {
        await expect(push(root, { io: createMockProviderIO().io })).rejects.toThrow(PushDriftError);
      } finally {
        midPack.target = null;
      }

      await fs.rm(root, { recursive: true, force: true });
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    });

    it('should accept mid-pack drift with allowDrift and restore the unchanged files', async () => {
      const root = await tmpDir();
      const dirs = [await tmpDir(), await tmpDir(), await tmpDir()];
      const firstAbs = path.join(root, 'a-first.bin');
      const lastAbs = path.join(root, 'z-last.bin');
      const lastContent = Buffer.alloc(256, 0xbb); // never mutated - must restore byte-for-byte
      await fs.writeFile(firstAbs, Buffer.alloc(256, 0xaa));
      await fs.writeFile(lastAbs, lastContent);
      await initVault(root, dirs);

      midPack.target = { triggerFile: lastAbs, mutateFile: firstAbs, mutateContent: Buffer.alloc(512, 0xcc) };
      let result: Awaited<ReturnType<typeof push>>;
      try {
        result = await push(root, { allowDrift: true, io: createMockProviderIO().io });
      } finally {
        midPack.target = null;
      }

      expect(result.health).toBe(VersionHealth.Healthy);

      // The accepted backup must still be recoverable: pull version 1 back and
      // confirm the file that did NOT drift comes back byte-for-byte.
      await pull(root, { version: result.version, force: true, io: createMockProviderIO().io });
      const restored = await fs.readFile(lastAbs);
      assert(restored.equals(lastContent), 'z-last.bin did not restore byte-for-byte');

      await fs.rm(root, { recursive: true, force: true });
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    });
  });
});

// --- RAM budget --------------------------------------------------------------
//
// The budget exists to keep a push inside the memory the operator allowed, and
// it is spent by the striped Reed-Solomon encoder - so it has to be divided by
// what that encoder holds at once. `rsEncodeStriped` (src/core/reed-solomon.ts)
// allocates two buffers before the read loop and keeps both alive until it
// returns: `flat` of (N+K) x stripeSize and `inputBlock` of N x stripeSize.
// Everything else on that path is a view, not a copy. The peak on the JS heap
// is therefore (2N+K) x stripeSize.
//
// The checks below pin that the peak FITS, not one particular arithmetic: an
// implementation may round or align as it likes. What they refuse is a budget
// overshoot - and today's is not a rounding difference but 167% of the budget at
// 2/1, because the divisor counts N+K.
//
// Above the JS heap sits the WASM encoder, which copies the working block into
// its own linear memory per stripe. Those instances are dropped each stripe but
// collected by GC, so the process can briefly hold more than one - a margin over
// the budget that stays documented rather than priced here.

const MIB = 1024 * 1024;
/** Ceiling on one stripe, from the shard format (V2_MAX_STRIPE_SIZE in core/shard-io). */
const MAX_STRIPE = 256 * MIB;
/** Floor on one stripe, below which striping costs more than it saves. */
const MIN_STRIPE = 16 * MIB;
/** Cap on a blob held in memory, independent of the encoder reservation. */
const MAX_BLOB_IN_RAM = 4 * 1024 * MIB;
/** Blob large enough that the per-shard payload never becomes the binding limit. */
const HUGE_BLOB = 8 * 1024 * MIB;

/** What the encoder holds at once, in stripes. */
function encoderPeakStripes(N: number, K: number): number {
  return 2 * N + K;
}

describe('_computeStripeSize', () => {
  it('should keep the encoder peak inside the budget it was given', () => {
    const budget = 500 * MIB;
    const stripe = _computeStripeSize({ maxRamMb: 500, N: 2, K: 1, blobSize: HUGE_BLOB });

    expect(encoderPeakStripes(2, 1) * stripe).toBeLessThanOrEqual(budget);
    // ...and spends most of it: a stripe far under the budget would satisfy the
    // line above while quietly costing throughput, so the fit must be tight.
    expect(stripe).toBeGreaterThan(Math.floor(budget / encoderPeakStripes(2, 1)) * 0.9);
  });

  it('should keep the peak inside the budget for a wider scheme too', () => {
    // 5/2 holds 12 stripes, not 7 - a divisor keyed to N+K overshoots by 1.71x.
    const budget = 1200 * MIB;
    const stripe = _computeStripeSize({ maxRamMb: 1200, N: 5, K: 2, blobSize: HUGE_BLOB });

    expect(encoderPeakStripes(5, 2) * stripe).toBeLessThanOrEqual(budget);
    expect(stripe).toBeGreaterThan(Math.floor(budget / encoderPeakStripes(5, 2)) * 0.9);
  });

  it('should size the stripe from detected memory when no budget was given', () => {
    // The path almost every user takes: `max_ram_mb` defaults to null, so the
    // budget is a quarter of system memory. Every other case here passes an
    // explicit budget, which is the one shape real runs rarely have.
    //
    // 2 GiB of memory, not 8: at 8 GiB the quarter-budget is large enough that
    // the 256 MiB stripe ceiling binds instead of the divisor, and the check
    // would hold for any divisor at all - including today's.
    vi.spyOn(os, 'totalmem').mockReturnValue(2 * 1024 * MIB);
    const budget = 512 * MIB;

    const stripe = _computeStripeSize({ maxRamMb: null, N: 2, K: 1, blobSize: HUGE_BLOB });

    expect(encoderPeakStripes(2, 1) * stripe).toBeLessThanOrEqual(budget);
    expect(stripe).toBeGreaterThan(Math.floor(budget / encoderPeakStripes(2, 1)) * 0.9);
  });

  it('should never leave the range the shard format accepts', () => {
    // The parser refuses a stripe of 0 or one above V2_MAX_STRIPE_SIZE
    // (parseCommonHeaderFields in core/shard-io), so a budget divided among a
    // very wide scheme must still land inside the range rather than underflow.
    //
    // Documentation of that invariant, not a guard: at 200/56 the division lands
    // far under the floor, which lifts the result to 16 MiB, and the two clamps
    // keep every branch inside the range - so no divisor can break this. What
    // enforces the invariant is `Math.max(V2_MIN_STRIPE_SIZE, Math.min(...))`,
    // and a real path to zero would come from a microscopic blob, not from the
    // budget.
    for (const [N, K] of [
      [2, 1],
      [5, 2],
      [200, 56],
    ] as const) {
      const stripe = _computeStripeSize({ maxRamMb: 64, N, K, blobSize: HUGE_BLOB });

      expect(stripe).toBeGreaterThan(0);
      expect(stripe).toBeLessThanOrEqual(MAX_STRIPE);
    }
  });

  it('should never exceed the stripe ceiling the shard format allows', () => {
    const stripe = _computeStripeSize({ maxRamMb: 64 * 1024, N: 2, K: 1, blobSize: HUGE_BLOB });

    expect(stripe).toBe(MAX_STRIPE);
  });

  it('should keep the stripe floor when the budget alone would go under it', () => {
    // The floor wins over the budget: striping smaller costs more than it saves,
    // and the resulting overrun is a budget too small to honour - not something
    // this function may quietly round away.
    const stripe = _computeStripeSize({ maxRamMb: 40, N: 2, K: 1, blobSize: HUGE_BLOB });

    expect(stripe).toBe(MIN_STRIPE);
  });

  it('should stop at the per-shard payload when the blob is smaller than the budget', () => {
    // A 100 MiB blob at 2/1 needs 50 MiB per shard; a larger stripe would be
    // padding, whatever the budget allows. Pinned exactly - the value is
    // deterministic (calcShardPayloadSize), and a bound would also pass for a
    // stripe of one byte.
    const stripe = _computeStripeSize({ maxRamMb: 4096, N: 2, K: 1, blobSize: 100 * MIB });

    expect(stripe).toBe(50 * MIB);
  });
});

describe('_computeRamThreshold', () => {
  it('should reserve the encoder peak before allowing a blob in memory', () => {
    const budget = 2048 * MIB;
    const threshold = _computeRamThreshold(2048, 2, 1);

    expect(threshold + encoderPeakStripes(2, 1) * MAX_STRIPE).toBeLessThanOrEqual(budget);
    // ...and hands the rest over. Reserving MORE than the encoder peaks at is
    // just as wrong in the other direction - it takes memory the operator
    // allowed and pushes blobs to disk that had room to stay in RAM.
    expect(threshold).toBeGreaterThan((budget - encoderPeakStripes(2, 1) * MAX_STRIPE) * 0.9);
  });

  it('should refuse the in-memory path when the budget cannot even cover the encoder', () => {
    // 1 GiB at 2/1 is under the 1280 MiB the encoder peaks at, so nothing may be
    // held in memory. This one is exact rather than approximate: it is not a
    // quantity but a choice of path, and getting it wrong means a push picks RAM
    // and then runs out of it - after the directory has already been packed.
    expect(_computeRamThreshold(1024, 2, 1)).toBe(0);
  });

  it('should reserve the peak for a wider scheme too', () => {
    // Deliberately under 7 GiB: above that both an honest and an optimistic
    // reservation land past the in-RAM blob cap, which would hide the difference.
    const budget = 6144 * MIB;
    const threshold = _computeRamThreshold(6144, 5, 2);

    expect(threshold + encoderPeakStripes(5, 2) * MAX_STRIPE).toBeLessThanOrEqual(budget);
    expect(threshold).toBeGreaterThan((budget - encoderPeakStripes(5, 2) * MAX_STRIPE) * 0.9);
  });

  it('should keep the in-RAM blob cap independent of the reservation', () => {
    // A budget large enough that the reservation stops binding - the cap takes
    // over. Without this, dropping the clamp while rewriting goes unnoticed.
    expect(_computeRamThreshold(16 * 1024, 2, 1)).toBe(MAX_BLOB_IN_RAM);
  });

  it('should derive the threshold from detected memory when no budget was given', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(8 * 1024 * MIB);

    const threshold = _computeRamThreshold(null, 2, 1);

    expect(threshold + encoderPeakStripes(2, 1) * MAX_STRIPE).toBeLessThanOrEqual(2 * 1024 * MIB);
  });
});

// Each function is pinned on its own above, so a half-applied correction - the
// divisor fixed but not the reservation, or the reverse - would still pass one
// of the two suites. This one refuses that: what the threshold hands to the blob
// plus what the encoder takes for its stripes has to fit the same budget.
describe('RAM budget consistency', () => {
  it('should let the blob and the encoder share one budget without exceeding it', () => {
    for (const [maxRamMb, N, K] of [
      [2048, 2, 1],
      [6144, 5, 2],
      [4096, 3, 2],
    ] as const) {
      const budget = maxRamMb * MIB;
      const threshold = _computeRamThreshold(maxRamMb, N, K);
      const stripe = _computeStripeSize({ maxRamMb, N, K, blobSize: HUGE_BLOB });

      expect(threshold + encoderPeakStripes(N, K) * stripe).toBeLessThanOrEqual(budget);
    }
  });
});
