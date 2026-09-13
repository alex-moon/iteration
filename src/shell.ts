import { execFileSync } from 'node:child_process';
import { log } from './log';

export function git(args: string[], mustSucceed = false): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (mustSucceed) throw err;
    return '';
  }
}

export function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function ghAllowFail(args: string[], what: string): string {
  try {
    return gh(args);
  } catch (err) {
    log(`${what} failed: ${(err as Error).message}`);
    return '';
  }
}

export function sleepSeconds(s: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
}
