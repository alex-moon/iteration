import fs from 'node:fs';
import path from 'node:path';

export const LOG_DIR = '.iteration/logs';
fs.mkdirSync(LOG_DIR, { recursive: true });
export const LOG_FILE = path.join(
  LOG_DIR,
  `iteration-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.log`,
);

export function log(msg: string): void {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.error(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`);
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
