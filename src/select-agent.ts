import fs from 'node:fs';
import readline from 'node:readline';
import { AGENTS, DEFAULT_AGENT_ID, agentById, type Agent } from './agents';
import { configFile, writeUserAgent } from './user-config';

/**
 * First-run agent selection. Presents a numbered menu on stderr and reads the
 * choice from the controlling TTY; the choice is persisted so this runs once
 * per user. When there is no interactive terminal (CI, piped invocation, a
 * phase agent calling back in) the default is used WITHOUT writing config, so
 * a later interactive run still gets the picker.
 */
export function chooseAgent(): Agent {
  const fd = interactiveFd();
  if (fd === null) {
    return agentById(DEFAULT_AGENT_ID) as Agent;
  }
  process.stderr.write(
    'No agent selected yet. Which coding agent should drive the phases?\n' +
      `${AGENTS.map((a, i) => `  ${i + 1}) ${a.label}  -  ${a.hint}`).join('\n')}\n`,
  );
  process.stderr.write(`Choose [1-${AGENTS.length}] (default 1: ${agentById(DEFAULT_AGENT_ID)?.label}): `);
  const index = Number(readLineSync(fd).trim());
  const chosen =
    Number.isInteger(index) && index >= 1 && index <= AGENTS.length
      ? AGENTS[index - 1]!
      : (agentById(DEFAULT_AGENT_ID) as Agent);

  process.stderr.write('\n');
  try {
    writeUserAgent(chosen.id);
    process.stderr.write(`Saved "${chosen.label}" to ${configFile()}. ` +
      'Change it later by editing that file or setting ITERATION_AGENT_CMD.\n');
  } catch (err) {
    process.stderr.write(`Could not save preference (${(err as Error).message}); using ${chosen.label} for now.\n`);
  }
  return chosen;
}

/** A readable fd for the controlling terminal, or null when non-interactive. */
function interactiveFd(): number | null {
  try {
    if (fs.statSync('/dev/tty').isCharacterDevice()) {
      return fs.openSync('/dev/tty', 'r');
    }
  } catch {
    // no controlling terminal
  }
  return process.stdin.isTTY ? 0 : null;
}

/** Reads one line where Enter ends it, tolerating CRLF and Ctrl-D. */
function readLineSync(fd: number): string {
  const buf = Buffer.alloc(1);
  let out = '';
  for (;;) {
    let read = 0;
    try {
      read = fs.readSync(fd, buf, 0, 1, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      break;
    }
    if (read === 0) break;
    const ch = buf.toString('utf8');
    if (ch === '\n') break;
    if (ch !== '\r') out += ch;
  }
  return out;
}