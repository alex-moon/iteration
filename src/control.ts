import fs from 'node:fs';
import path from 'node:path';
import { sleepSeconds } from './shell';
import { ITERATION_DIR } from './snapshot';

interface Control {
  paused?: boolean;
  cancel?: boolean;
}

export function controlFile(): string {
  return path.join(ITERATION_DIR, 'control.json');
}

function readControl(): Control {
  try {
    const raw = JSON.parse(fs.readFileSync(controlFile(), 'utf8')) as Partial<Control>;
    return { paused: raw.paused === true, cancel: raw.cancel === true };
  } catch {
    return {};
  }
}

export function isPaused(): boolean {
  return readControl().paused === true;
}

export function clearControl(): void {
  try {
    fs.rmSync(controlFile());
  } catch {
    // already gone
  }
}

/**
 * Cooperative checkpoint between phases. Blocks while paused (polls every few
 * seconds); returns 'ok' to continue or 'cancel' when the user asked for a
 * clean stop after the current phase.
 */
export function checkpoint(): 'ok' | 'cancel' {
  let paused = false;
  while (true) {
    const c = readControl();
    if (c.cancel === true) {
      clearControl();
      return 'cancel';
    }
    if (c.paused === true) {
      paused = true;
      sleepSeconds(2);
      continue;
    }
    if (paused) clearControl();
    return 'ok';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled by user');
  }
}

export function checkpointEx(): void {
  if (checkpoint() === 'cancel') throw new CancelledError();
}
