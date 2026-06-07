import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEnoent } from '../core/fs-utils.js';

/** User-level global preferences for BFS (stored outside any vault). */
export interface GlobalSettings {
  /** BCP 47 language tag. null = use built-in default ('en'). */
  language: Nullable<string>;
}

/** Returned when no settings file exists yet. */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = { language: null };

/**
 * Returns the platform-appropriate path to the global BFS settings file.
 * Priority:
 *   Linux/macOS — $XDG_CONFIG_HOME/bfs/settings.json (if set)
 *   Linux/macOS — ~/.config/bfs/settings.json
 *   Windows     — %APPDATA%\bfs\settings.json
 *   Fallback    — ~/.bfs/settings.json
 */
export function getGlobalSettingsPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'bfs', 'settings.json');

  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, 'bfs', 'settings.json');

  // Linux/macOS without XDG, and non-Windows fallback
  return path.join(os.homedir(), '.config', 'bfs', 'settings.json');
}

/**
 * Reads global BFS settings from the user's config directory.
 * Returns defaults when the file does not exist.
 * @throws on read/parse errors other than ENOENT.
 */
export async function readGlobalSettings(): Promise<GlobalSettings> {
  const filePath = getGlobalSettingsPath();
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as GlobalSettings;
  } catch (err: unknown) {
    if (isEnoent(err)) return { ...DEFAULT_GLOBAL_SETTINGS };
    throw err;
  }
}

/**
 * Writes global BFS settings to the user's config directory.
 * Creates the directory if it does not exist.
 * @throws on write failure.
 */
export async function writeGlobalSettings(settings: GlobalSettings): Promise<void> {
  const filePath = getGlobalSettingsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}
