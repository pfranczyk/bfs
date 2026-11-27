import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { readState, writeState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

// The password that opens a version's location map is the same one that decrypts
// its data, so the operator reaching for that version supplies it anyway - which
// is why recovery may leave the version merely marked, and `pull` is where it
// gets rebuilt. Listing the storages, finding the parts, opening the map from a
// header and restoring costs nothing extra; what it saves is the operator being
// asked for passwords to versions nobody wants.
//
// The manifest is written only once the data is out: a run cut short leaves the
// marker exactly as it was, so the next attempt starts from a clean state rather
// than from a record describing a restore that never happened.

const VAULT_NAME = 'pull-lazy-rebuild';
const PW_V1 = 'first-secret';
const PW_V2 = 'rotated-secret';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function markerPath(root: string, version: number): string {
  return path.join(root, '.bfs', 'manifests', `v${String(version).padStart(3, '0')}.json`);
}

/**
 * Flips one byte of the KDF salt in a part's header, in place, WITHOUT
 * recomputing the part's trailing checksum - the shape bit-rot leaves behind.
 * The header still parses; only the key derived from it is wrong.
 */
async function damageSalt(file: string): Promise<void> {
  const bytes = await fs.readFile(file);
  const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(bytes));
  payloadStream.on('error', () => {}).destroy();
  assert(header.kdf_salt !== null, `${file} must be an encrypted part carrying a salt`);
  const at = bytes.indexOf(header.kdf_salt);
  assert(at >= 0, 'the salt must be found in the part header');
  const byte = bytes[at];
  assert(byte !== undefined, 'the salt byte must exist');
  bytes[at] = byte ^ 0xff;
  await fs.writeFile(file, bytes);
}

/** Path of p0's part of version 2 - the first part pull reads. */
function firstPartOfV2(pdirs: readonly string[]): string {
  const dir = pdirs[0];
  assert(dir !== undefined, 'the fixture must have a first medium');
  return path.join(dir, VAULT_NAME, 'shard_0.bfs.2');
}

/**
 * The location-map-from-a-sibling lines in a run. The marker is derived from the
 * message itself and checked to be non-empty, so a reworded message cannot turn
 * the checks that expect none into checks that pass on nothing.
 */
function siblingLines(logs: ReadonlyArray<{ level: string; message: string }>): string[] {
  const marker = fmt('recovery_map_from_sibling', '2', '').split(' - ')[0] ?? '';
  assert(marker.length > 0, 'the sibling-line marker must not be empty');
  return logs.filter((l) => l.level === 'warn' && l.message.startsWith(marker)).map((l) => l.message);
}

/** An operator at a terminal typing the given answers in turn, recording each prompt. */
function interactiveIo(root: string, answers: string[]): { io: ProviderIO; asked: string[]; logs: Array<{ level: string; message: string }> } {
  const asked: string[] = [];
  const queue = [...answers];
  const base = createMockProviderIO({}, root, true);
  const io: ProviderIO = {
    ...base.io,
    askSecret: async (prompt: string): Promise<string> => {
      asked.push(prompt);
      return queue.shift() ?? '';
    },
  };
  return { io, asked, logs: base.logs };
}

describe('pull rebuilding a version that recovery left marked', () => {
  let root: string;
  let pdirs: string[];
  let io: ProviderIO;

  beforeEach(async () => {
    root = await mkTmp('bfs-lazy-root-');
    pdirs = [await mkTmp('bfs-lazy-p0-'), await mkTmp('bfs-lazy-p1-'), await mkTmp('bfs-lazy-p2-')];
    io = createMockProviderIO({}, root, false).io;

    await init(root, {
      vault_name: VAULT_NAME,
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });

    await fs.writeFile(path.join(root, 'a.txt'), 'contents of version one', 'utf-8');
    await push(root, { io, password: PW_V1 });
    await fs.writeFile(path.join(root, 'a.txt'), 'contents of version two', 'utf-8');
    await push(root, { io, password: PW_V2 });

    // The state a recovery leaves when it opened v1 and met v2 without its
    // password: a marker in place of v2's manifest, and a counter that knows v2
    // is out there.
    await fs.writeFile(markerPath(root, 2), '{}', 'utf-8');
    await writeState(root, { latest_version: 2, working_version: 0 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should restore the version once its password is supplied', async () => {
    await pull(root, { version: 2, password: PW_V2, force: true, yes: true, io });

    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8'), "the restored file must carry that version's contents").toBe('contents of version two');
  });

  it('should complete the manifest of the version it restored', async () => {
    await pull(root, { version: 2, password: PW_V2, force: true, yes: true, io });

    const manifest = await readManifest(root, 2);
    expect(manifest?.shards.map((s) => s.provider_id).sort(), 'the rebuilt manifest must record where every part of that version lives').toEqual(['p0', 'p1', 'p2']);
    expect((await readState(root)).working_version).toBe(2);
  });

  // The marker is the state a retry starts from. A manifest written before the
  // data is out would describe a restore that did not happen, and a half-written
  // one would be worse than none.
  it('should leave the marker untouched when the password does not open the version', async () => {
    await expect(pull(root, { version: 2, password: 'not-the-password', force: true, yes: true, io })).rejects.toThrow();

    expect(await fs.readFile(markerPath(root, 2), 'utf-8'), 'a failed attempt must leave the version exactly as marked').toBe('{}');
  });

  // The refusal has to name what actually went wrong. Sending the operator back
  // to `bfs recovery` is the answer from before this path existed, and it is not
  // executable any more: they just handed that password to this very command, and
  // running recovery with it would change nothing.
  it('should blame the password, not send the operator back to recovery', async () => {
    const outcome = await pull(root, { version: 2, password: 'not-the-password', force: true, yes: true, io }).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(outcome).toMatch(/does not open version 2/i);
    expect(outcome, 'recovery cannot help with a password this command was already given').not.toMatch(/bfs recovery/i);
  });

  // Map and data are sealed with the same key, so one question covers both. Asked
  // twice, the operator would reasonably conclude the first answer was rejected.
  it('should ask for the password once, not once per gate', async () => {
    const asked: string[] = [];
    const base = createMockProviderIO({}, root, true).io;
    const askingIo: ProviderIO = {
      ...base,
      askSecret: async (prompt: string): Promise<string> => {
        asked.push(prompt);
        return PW_V2;
      },
    };

    await pull(root, { version: 2, force: true, yes: true, io: askingIo });

    expect(asked.length, `opening the location map and decrypting the data take the same key - asking twice reads as the first answer having been wrong (asked: ${asked.join(' | ')})`).toBe(1);
  });

  // A run with nobody at the keyboard cannot be asked, so it must say which flag
  // was missing instead of stalling on a question no one will answer.
  it('should name the password flag when nobody can be asked', async () => {
    const quietIo = createMockProviderIO({}, root, false).io;

    const outcome = await pull(root, { version: 2, force: true, yes: true, io: quietIo }).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(outcome).toMatch(/--password/);
  });

  // `--cache` skips downloading the parts, not the question of which version this
  // is. Letting it past the rebuild would unpack the data and leave the version
  // still marked - restored and unrecovered at the same time. The pull fails here
  // on the deliberately invalid cache; what matters is that it looked first.
  it('should not let --cache bypass the rebuild', async () => {
    await fs.mkdir(path.join(root, '.bfs', 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.bfs', 'cache', 'pull.blob.pending'), 'not a blob', 'utf-8');
    const listSpy = vi.spyOn(LocalFsProvider.prototype, 'list');

    await pull(root, { version: 2, password: PW_V2, force: true, yes: true, fromCache: true, io }).catch(() => undefined);

    expect(listSpy, 'a version with no manifest must be rebuilt before any cached payload is used, or it stays marked forever').toHaveBeenCalled();
    // The map opened here - this run got past the password and died later, on the
    // deliberately invalid cache. That is the moment the "manifest only after the
    // data is out" rule is actually load-bearing.
    expect(await fs.readFile(markerPath(root, 2), 'utf-8'), 'a run that opened the map and then failed must still leave nothing but the marker').toBe('{}');
  });

  // Parts are there and the storages answer, but nothing readable comes back -
  // rot, truncation, a shard from another backup. Saying "no parts found" would
  // be wrong, and a password prompt would be pointless.
  it('should name unreadable parts rather than blame the password', async () => {
    for (const [index, dir] of pdirs.entries()) {
      await fs.writeFile(path.join(dir, VAULT_NAME, `shard_${index}.bfs.2`), 'not a shard', 'utf-8');
    }

    const outcome = await pull(root, { version: 2, password: PW_V2, force: true, yes: true, io }).then(
      () => 'resolved',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(outcome).toMatch(/could not be read/i);
    expect(outcome, 'the password was never the problem here').not.toMatch(/does not open version/i);
  });

  // The parts of a version share one salt, so a typed password can be judged on
  // any of them. Judged on the first part alone, a bit-rot in that part's salt
  // turns the correct password into "wrong" - over and over, with the healthy
  // siblings that would open sitting right there.
  it('should accept the correct typed password when the first part has a damaged salt', async () => {
    await damageSalt(firstPartOfV2(pdirs));
    const { io: askingIo, asked, logs } = interactiveIo(root, [PW_V2, '']);

    const outcome = await pull(root, { version: 2, force: true, yes: true, io: askingIo }).then(
      () => 'restored',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(asked, 'the correct password must open a healthy sibling, not be retried against the damaged part').toEqual([fmt('pull_ask_version_password', '2')]);
    expect(outcome).toBe('restored');
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('contents of version two');
    // The damaged part is the one that could not supply the map - name it, and
    // only it.
    expect(siblingLines(logs)).toEqual([fmt('recovery_map_from_sibling', '2', 'p0')]);
  });

  it('should accept the correct password typed after a mistyped one when the first part has a damaged salt', async () => {
    // The retry is judged the same way as the first answer: on any part.
    await damageSalt(firstPartOfV2(pdirs));
    const { io: askingIo, asked } = interactiveIo(root, ['mistyped', PW_V2, '']);

    const outcome = await pull(root, { version: 2, force: true, yes: true, io: askingIo }).then(
      () => 'restored',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(outcome).toBe('restored');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(fmt('pull_ask_version_password', '2'));
    expect(asked[1]).toMatch(/^Wrong password/);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('contents of version two');
  });

  // With no --password the pool is empty, so every part "fails" it before the
  // prompt - but that says nothing about the parts. A medium is named as unable
  // to supply the map only when the password that opened the version did not
  // open its part.
  it('should not name any medium when the typed password opens the first part', async () => {
    const { io: askingIo, logs } = interactiveIo(root, [PW_V2]);

    await pull(root, { version: 2, force: true, yes: true, io: askingIo });

    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('contents of version two');
    expect(siblingLines(logs), 'every part is healthy - none of them failed to supply the map').toEqual([]);
  });

  it('should not name any medium when a wrong --password is followed by the right one at the prompt', async () => {
    // A non-empty pool that every part refuses says as little about the parts
    // as an empty one: the password was wrong, not the media.
    const { io: askingIo, logs } = interactiveIo(root, [PW_V2]);

    await pull(root, { version: 2, password: 'not-the-password', force: true, yes: true, io: askingIo });

    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('contents of version two');
    expect(siblingLines(logs), 'every part is healthy - none of them failed to supply the map').toEqual([]);
  });

  // A part of another version filed under this version's name (copied by hand,
  // a sync script) opens with that version's password. Typed at the prompt, that
  // older password must still read as wrong for this version - not open the
  // misfiled part and end the command - so the operator can type the right one.
  it('should not let an older password open a part of another version filed under this name', async () => {
    const dir = pdirs[2];
    assert(dir !== undefined, 'the fixture must have a third medium');
    await fs.copyFile(path.join(dir, VAULT_NAME, 'shard_2.bfs.1'), path.join(dir, VAULT_NAME, 'shard_2.bfs.2'));
    const { io: askingIo, asked } = interactiveIo(root, [PW_V1, PW_V2]);

    const outcome = await pull(root, { version: 2, force: true, yes: true, io: askingIo }).then(
      () => 'restored',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    expect(outcome).toBe('restored');
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatch(/^Wrong password/);
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('contents of version two');
  });

  // A wrong password still opens nothing anywhere and is still refused.
  it('should keep refusing a wrong typed password when the first part has a damaged salt (negative control)', async () => {
    await damageSalt(firstPartOfV2(pdirs));
    const { io: askingIo, asked } = interactiveIo(root, ['not-the-password', '']);

    // Refused as a matter of the password, not as unreadable parts.
    await expect(pull(root, { version: 2, force: true, yes: true, io: askingIo })).rejects.toThrow(new BfsError(`${fmt('pull_version_password_required', '2')} ${fmt('pull_restorable_hint', '1', '1')}`));

    expect(asked).toHaveLength(2);
    expect(asked[0]).toBe(fmt('pull_ask_version_password', '2'));
    expect(asked[1]).toMatch(/^Wrong password/);
    expect(await fs.readFile(markerPath(root, 2), 'utf-8')).toBe('{}');
  });

  // Without a marker there is nothing to say the version is out there, and a
  // pruned version must not send the operator hunting across the storages.
  it('should refuse a version with no marker without contacting any storage', async () => {
    await fs.rm(markerPath(root, 2));
    const listSpy = vi.spyOn(LocalFsProvider.prototype, 'list');

    await expect(pull(root, { version: 2, force: true, yes: true, io })).rejects.toThrow(/not found/i);

    expect(listSpy, 'a version this directory has no record of must cost no network round trip').not.toHaveBeenCalled();
  });
});
