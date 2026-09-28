import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * User-level config: which agent drives the phases, remembered across runs so
 * the first-run picker only ever appears once. Stored per user (not per repo)
 * in the OS-standard config dir, following the convention used by CLI tools
 * (`~/.config/iteration/config.json` on POSIX, `%APPDATA%/iteration` on
 * Windows; `$XDG_CONFIG_HOME` is honoured). Kept dependency-free on purpose -
 * a one-field JSON file does not justify pulling in a config library.
 *
 * Two env overrides exist for tests and scripted runs:
 * - ITERATION_CONFIG_DIR  replaces the whole config directory
 * - ITERATION_CONFIG_FILE replaces the file path outright
 */
interface UserConfig {
  agent?: string;
}

export function configDir(): string {
  const override = process.env.ITERATION_CONFIG_DIR;
  if (override !== undefined && override.trim() !== '') return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.trim() !== ''
      ? xdg
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : path.join(os.homedir(), '.config');
  return path.join(base, 'iteration');
}

export function configFile(): string {
  const override = process.env.ITERATION_CONFIG_FILE;
  if (override !== undefined && override.trim() !== '') return override;
  return path.join(configDir(), 'config.json');
}

export function readUserConfig(): UserConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile(), 'utf8')) as unknown;
    if (raw !== null && typeof raw === 'object') {
      const agent = (raw as { agent?: unknown }).agent;
      return typeof agent === 'string' ? { agent } : {};
    }
  } catch {
    // missing or malformed config just means "not chosen yet"
  }
  return {};
}

export function writeUserAgent(agent: string): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next: UserConfig = { ...readUserConfig(), agent };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}
