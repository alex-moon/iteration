import rl from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { readStatus, statusAgeSeconds } from './status';
import { controlFile } from './control';
import { LOG_DIR } from './log';

const REFRESH_MS = 1000;
const LOG_LINES = 15;
const STALE_SECONDS = 120;

const GREY = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function latestLogFile(): string | null {
  let newest: { name: string; mtime: number } | null = null;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.startsWith('iteration-') || !f.endsWith('.log')) continue;
      const full = path.join(LOG_DIR, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (newest === null || mtime > newest.mtime) newest = { name: f, mtime };
    }
  } catch {
    return null;
  }
  return newest === null ? null : path.join(LOG_DIR, newest.name);
}

function tailLines(file: string | null): string[] {
  if (file === null) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8').split('\n');
    return raw.slice(-LOG_LINES - 1, -1).slice(-LOG_LINES);
  } catch {
    return [];
  }
}

const PHASE_LABELS: Record<string, string> = {
  'idle-between-passes': 'idle (waiting for next pass)',
  'limited-check-idle': 'idle (shutdown-limited check pending)',
  'decision-idle': 'idle (shutdown decision in effect)',
};

export function frameText(
  width: number,
  height: number,
  status: ReturnType<typeof readStatus>,
  paused: boolean,
  cancelFlag: boolean,
): string {
  const pad = (s: string): string => (s.length <= width ? s + ' '.repeat(width - s.length) : s.slice(0, width - 1) + '…');
  const lines: string[] = [];
  const emit = (text: string, color = ''): void => {
    if (lines.length < height - 1) lines.push(color + pad(text) + RESET);
  };
  emit('iteration control center', BOLD + CYAN);
  if (status === null) {
    emit('orchestrator not running (no .iteration/status.json yet)', RED);
  } else {
    const t = status.ticket;
    const ticket = t.number === null ? '(none)' : `#${t.number} "${(t.title ?? '').replace(/\n/g, ' ')}"`;
    emit(
      `repo: ${status.repo ?? '?'}  mode: ${status.mode}` +
        (status.strikes === null ? '' : `  strikes ${status.strikes}`),
    );
    emit(`phase:  ${PHASE_LABELS[status.phase] ?? status.phase}`, CYAN);
    emit(`ticket: ${ticket}`, GREEN);
    emit(`branch: ${t.branch ?? '(none)'}`, CYAN);
    emit(`PR:     ${t.pr ?? '(none)'}`, GREEN);
  }
  const banner =
    cancelFlag ? '=== CANCEL REQUESTED: loop stops after the current phase ==='
    : paused ? '=== PAUSED: loop parks at the next phase boundary ==='
    : '';
  if (banner !== '') emit(banner, BOLD + RED);
  emit(`[log ${latestLogFile()} | age ${status === null ? 'n/a' : `${statusAgeSeconds(status)}s`}${status !== null && statusAgeSeconds(status) > STALE_SECONDS ? ' STALE' : ''}]`, GREY);
  for (const raw of tailLines(latestLogFile())) emit(raw, GREY);
  while (lines.length < height - 1) lines.push(' ');
  lines.push(
    BOLD + pad(` [p] ${paused ? 'resume' : 'pause'}   [c] cancel loop   [q] quit TUI`) + RESET,
  );
  return lines.join('\r\n') + '\r\n';
}

function controlPaused(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(controlFile(), 'utf8')) as { paused?: boolean };
    return raw.paused === true;
  } catch {
    return false;
  }
}

function controlCancel(): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(controlFile(), 'utf8')) as { cancel?: boolean };
    return raw.cancel === true;
  } catch {
    return false;
  }
}

export function runTui(): void {
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  rl.emitKeypressEvents(process.stdin);

  const writeFrame = (): void => {
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const cancel = controlCancel();
    process.stdout.write('\x1b[H');
    process.stdout.write(
      frameText(cols, rows, readStatus(), controlPaused(), cancel) + '\x1b[J',
    );
  };

  const timer = setInterval(writeFrame, REFRESH_MS);
  writeFrame();

  process.stdin.on('keypress', (_s: string, key: { name: string; ctrl: boolean }): void => {
    if (key.ctrl && key.name === 'c') key.name = 'q';
    if (key.name === 'q') {
      clearInterval(timer);
      process.stdout.write('\x1b[?1049l\x1b[?25h');
      process.exit(0);
    }
    if (key.name === 'p') {
      const next = !controlPaused();
      fs.mkdirSync(path.dirname(controlFile()), { recursive: true });
      fs.writeFileSync(
        controlFile(),
        `${JSON.stringify({ paused: next }, null, 2)}\n`,
      );
      writeFrame();
    }
    if (key.name === 'c') {
      fs.mkdirSync(path.dirname(controlFile()), { recursive: true });
      fs.writeFileSync(
        controlFile(),
        `${JSON.stringify({ paused: controlPaused(), cancel: true }, null, 2)}\n`,
      );
      writeFrame();
    }
  });
  process.stdout.on('resize', writeFrame);
}
