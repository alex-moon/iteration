import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './state-dir';

export interface StatusTicket {
  number: number | null;
  title: string | null;
  branch: string | null;
  pr: string | null;
}

export interface Status {
  updatedAt: string;
  phase: string;
  mode: string;
  strikes: string | null;
  ticket: StatusTicket;
  repo: string | null;
}

let lastStatus: Status | null = null;

export function statusFile(): string {
  return path.join(stateDir(), 'status.json');
}

export function readStatus(): Status | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as Partial<Status> & {
      ticket?: Partial<StatusTicket>;
    };
    if (typeof raw.updatedAt !== 'string' || typeof raw.phase !== 'string') return null;
    const ticket: Partial<StatusTicket> = raw.ticket ?? {};
    return {
      updatedAt: raw.updatedAt,
      phase: raw.phase,
      mode: typeof raw.mode === 'string' ? raw.mode : 'running',
      strikes: typeof raw.strikes === 'string' ? raw.strikes : null,
      repo: typeof raw.repo === 'string' ? raw.repo : null,
      ticket: {
        number: typeof ticket.number === 'number' ? ticket.number : null,
        title: typeof ticket.title === 'string' ? ticket.title : null,
        branch: typeof ticket.branch === 'string' ? ticket.branch : null,
        pr: typeof ticket.pr === 'string' ? ticket.pr : null,
      },
    };
  } catch {
    return lastStatus;
  }
}

export function statusAgeSeconds(s: Status): number {
  return Math.round((Date.now() - Date.parse(s.updatedAt)) / 1000);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function clearStatus(): void {
  try {
    fs.rmSync(statusFile());
  } catch {
    // already gone
  }
}

/**
 * Refresh updatedAt in place (heartbeat): a dead harness leaves a stale
 * timestamp, so consumers can tell 'stalled/never-written' apart from 'alive'.
 */
export function touchStatus(): void {
  try {
    const s = JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as { updatedAt?: string };
    if (typeof s.updatedAt !== 'string') return;
    s.updatedAt = nowIso();
    fs.writeFileSync(statusFile(), `${JSON.stringify(s, null, 2)}\n`);
  } catch {
    // no status file yet
  }
}

export function setStatus(partial: {
  phase: string;
  mode: string;
  repo: string | null;
  strikes?: string | null;
  number?: number | null;
  title?: string | null;
  branch?: string | null;
  pr?: string | null;
}): void {
  lastStatus = {
    updatedAt: nowIso(),
    phase: partial.phase,
    mode: partial.mode,
    strikes: partial.strikes ?? null,
    repo: partial.repo,
    ticket: {
      number: partial.number ?? null,
      title: partial.title ?? null,
      branch: partial.branch ?? null,
      pr: partial.pr ?? null,
    },
  };
  fs.writeFileSync(statusFile(), `${JSON.stringify(lastStatus, null, 2)}\n`);
}
