import fs from 'node:fs';
import path from 'node:path';
import type { LoopState } from './types';
import { log } from './log';
import { STRIKE_LIMIT } from './config';
import { stateDir } from './state-dir';

const STATE_FILE = path.join(stateDir(), 'loop-state.json');

export function loadLoopState(): LoopState | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(STATE_FILE, 'utf8'),
    ) as Partial<LoopState>;
    const mode = raw.mode === 'decision' || raw.mode === 'strikes' ? raw.mode : null;
    if (mode === null) return null;
    return {
      strikes: typeof raw.strikes === 'number' ? raw.strikes : 0,
      decidedAt: typeof raw.decidedAt === 'string' ? raw.decidedAt : null,
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      activity: typeof raw.activity === 'string' ? raw.activity : null,
      mode,
    };
  } catch {
    return null;
  }
}

export function writeLoopState(
  strikes: number,
  mode: LoopState['mode'],
  decidedAt: string | null,
  reason: string | null,
  activity: string | null = null,
): void {
  fs.writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ strikes, decidedAt, reason, activity, mode }, null, 2)}\n`,
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Registers a strike; returns true to keep looping, false when the limit is exhausted. */
export function addStrike(mode: LoopState['mode'], reason: string): boolean {
  const prev = loadLoopState();
  const strikes = (prev?.strikes ?? 0) + 1;
  if (prev?.decidedAt) {
    writeLoopState(strikes, mode, prev.decidedAt, prev.reason);
  } else {
    writeLoopState(strikes, mode, nowIso(), reason);
  }
  log(`Strike ${strikes}/${STRIKE_LIMIT}: ${reason}`);
  return strikes < STRIKE_LIMIT;
}

export function clearShutdown(): void {
  try {
    fs.rmSync(STATE_FILE);
  } catch {
    // already gone
  }
  log('Decision overturned - new information in GitHub issues; resuming full work');
}
