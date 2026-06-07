import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GLOBAL_SETTINGS, getGlobalSettingsPath, readGlobalSettings, writeGlobalSettings } from '../../src/global/settings.js';

/** Sets XDG_CONFIG_HOME to tmpDir/config so getGlobalSettingsPath() uses it. */
function useXdgDir(dir: string): string {
  const configDir = path.join(dir, 'config');
  process.env.XDG_CONFIG_HOME = configDir;
  return path.join(configDir, 'bfs', 'settings.json');
}

function restoreXdg(orig: string | undefined): void {
  if (orig === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = orig;
  }
}

describe('getGlobalSettingsPath', () => {
  it('should return a path containing "bfs" and ending with "settings.json"', () => {
    const p = getGlobalSettingsPath();
    expect(p).toContain('bfs');
    expect(p.endsWith('settings.json')).toBe(true);
  });

  it('should use XDG_CONFIG_HOME when set', () => {
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    try {
      const p = getGlobalSettingsPath();
      expect(p).toBe(path.join('/tmp/xdg', 'bfs', 'settings.json'));
    } finally {
      restoreXdg(origXdg);
    }
  });
});

describe('readGlobalSettings', () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-settings-test-'));
    origXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    restoreXdg(origXdg);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return defaults when the file does not exist', async () => {
    useXdgDir(tmpDir);
    const settings = await readGlobalSettings();
    expect(settings).toEqual(DEFAULT_GLOBAL_SETTINGS);
    expect(settings.language).toBeNull();
  });

  it('should round-trip with writeGlobalSettings', async () => {
    useXdgDir(tmpDir);
    await writeGlobalSettings({ language: 'pl' });
    const result = await readGlobalSettings();
    expect(result.language).toBe('pl');
  });
});

describe('writeGlobalSettings', () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-settings-test-'));
    origXdg = process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    restoreXdg(origXdg);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should create the directory if it does not exist', async () => {
    const filePath = useXdgDir(tmpDir);
    await writeGlobalSettings({ language: 'en' });
    const content = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(content)).toEqual({ language: 'en' });
  });

  it('should write pretty-printed JSON', async () => {
    const filePath = useXdgDir(tmpDir);
    await writeGlobalSettings({ language: null });
    const raw = await fs.readFile(filePath, 'utf-8');
    // pretty-printed JSON has newlines
    expect(raw).toContain('\n');
    expect(JSON.parse(raw).language).toBeNull();
  });
});
