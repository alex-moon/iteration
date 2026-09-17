import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state-dir';

function pidFile(): string {
  return path.join(stateDir(), 'pid.json');
}

export function readPid(): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(pidFile(), 'utf8')) as { pid?: number };
    return typeof raw.pid === 'number' ? raw.pid : null;
  } catch {
    return null;
  }
}

export function writePid(): void {
  fs.writeFileSync(pidFile(), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
}

export function clearPid(): void {
  try {
    fs.rmSync(pidFile());
  } catch {
    // already gone
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
