import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state-dir';

export function logDir(): string {
  return path.join(stateDir(), 'logs');
}

let file: string | null = null;

export function logFile(): string {
  if (file === null)
    file = path.join(
      logDir(),
      `iteration-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.log`,
    );
  return file;
}

export function log(msg: string): void {
  const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
  console.error(line);
  fs.mkdirSync(logDir(), { recursive: true });
  fs.appendFileSync(logFile(), `${line}\n`);
}

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
