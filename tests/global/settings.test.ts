import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function restoreAppData(orig: string | undefined): void {
  if (orig === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = orig;
  }
}

describe('getGlobalSettingsPath', () => {
  // The homedir spy below patches a node builtin, which lives outside Vitest's
  // per-file module sandbox: a fork reused for the next test file would inherit
  // it. Each test restores its own in `finally`; this is the net for the day one
  // of them grows an early return.
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('should prefer XDG_CONFIG_HOME over APPDATA when both are set', () => {
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg';
    process.env.APPDATA = '/tmp/appdata';

    try {
      const p = getGlobalSettingsPath();

      expect(p).toBe(path.join('/tmp/xdg', 'bfs', 'settings.json'));
    } finally {
      restoreXdg(origXdg);
      restoreAppData(origAppData);
    }
  });

  it('should fall back to APPDATA when XDG_CONFIG_HOME is unset', () => {
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origAppData = process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
    process.env.APPDATA = '/tmp/appdata';

    try {
      const p = getGlobalSettingsPath();

      expect(p).toBe(path.join('/tmp/appdata', 'bfs', 'settings.json'));
    } finally {
      restoreXdg(origXdg);
      restoreAppData(origAppData);
    }
  });

  it('should fall back to the home directory when neither XDG_CONFIG_HOME nor APPDATA is set', () => {
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origAppData = process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.APPDATA;
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue('/tmp/home');

    try {
      const p = getGlobalSettingsPath();

      expect(p).toBe(path.join('/tmp/home', '.config', 'bfs', 'settings.json'));
    } finally {
      homedir.mockRestore();
      restoreXdg(origXdg);
      restoreAppData(origAppData);
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
