import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readState, writeState } from '../../src/vault/state.js';
import { fileIdentity, interruptWritesHalfway, SIMULATED_CRASH, strayTempFiles } from '../helpers/interrupted-write.js';

describe('writeState', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function makeVaultDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-state-'));
    tmpDirs.push(dir);
    await fs.mkdir(path.join(dir, '.bfs'), { recursive: true });
    return dir;
  }

  it('should round-trip state through writeState/readState', async () => {
    const dir = await makeVaultDir();
    const state = { latest_version: 7, working_version: 5 };

    await writeState(dir, state);

    expect(await readState(dir)).toEqual(state);
  });

  // POSIX-only: state.json sits next to config.json and is kept owner-only.
  // Windows NTFS ignores POSIX mode bits, so the assertion would be a false signal.
  it.skipIf(process.platform === 'win32')('should restrict an existing state.json to 0600 on overwrite', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'state.json');
    await fs.writeFile(filePath, '{}', { mode: 0o644 });

    await writeState(dir, { latest_version: 1, working_version: 1 });

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // latest_version is what push numbers the next version from, so a torn
  // state.json after a process died mid-write loses it. The previous content
  // must survive an interrupted write; the death is modelled as a write that
  // lands half of its bytes and then fails.
  it('should keep the previous state.json intact when the write is interrupted', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'state.json');
    await writeState(dir, { latest_version: 12, working_version: 12 });
    const before = await fs.readFile(filePath, 'utf-8');
    interruptWritesHalfway();

    await expect(writeState(dir, { latest_version: 13, working_version: 13 })).rejects.toThrow(SIMULATED_CRASH);

    vi.restoreAllMocks();
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('should leave no state.json at all when the first write is interrupted', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'state.json');
    interruptWritesHalfway();

    await expect(writeState(dir, { latest_version: 1, working_version: 1 })).rejects.toThrow(SIMULATED_CRASH);

    vi.restoreAllMocks();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The guarantee above holds only if the new content reaches the final name in
  // one step. Rewriting the file in place - or copying a finished temporary over
  // it - keeps the file's identity and can still be cut short; a rename swaps in
  // a different file.
  it('should replace state.json with a new file rather than rewrite it in place', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'state.json');
    await writeState(dir, { latest_version: 1, working_version: 1 });
    const before = await fileIdentity(filePath);

    await writeState(dir, { latest_version: 2, working_version: 2 });

    expect(await fileIdentity(filePath)).not.toBe(before);
    expect(await readState(dir)).toEqual({ latest_version: 2, working_version: 2 });
    expect(await strayTempFiles(filePath)).toEqual([]);
  });
});
