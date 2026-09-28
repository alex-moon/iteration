import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logDir, logFile, log } from './log';
import type { Validator } from './verdicts';
import { extractJsonVerdict } from './verdicts';
import { takeSubmittedVerdict } from './submit-state';
import { recordVerdictOutcome } from './verdict-stats';
import { agentById, DEFAULT_AGENT_ID, type Agent } from './agents';
import { readUserConfig, writeUserAgent } from './user-config';
import { chooseAgent } from './select-agent';

/**
 * The agent command is resolved once, in priority order:
 * 1. ITERATION_AGENT_CMD - the full command line ("node mock-agent.js ..."),
 *    kept as the escape hatch for mock runs and custom wrapping.
 * 2. the per-user cached choice (set by an earlier first-run pick).
 * 3. a first-run picker; stored so it never appears again.
 * The resolved command is cached for the life of the process.
 */
let resolved: string[] | null = null;

export function agentCommand(): string[] {
  return resolveAgent().command;
}

/** Resolves (and, when needed, asks for) the agent; safe to call repeatedly. */
export function resolveAgent(): Agent {
  const spec = process.env.ITERATION_AGENT_CMD;
  if (spec !== undefined && spec.trim() !== '') {
    return { id: 'custom', label: spec.trim(), command: spec.split(' ').filter(Boolean), hint: 'ITERATION_AGENT_CMD' };
  }
  const cachedId = readUserConfig().agent;
  const cached = cachedId === undefined ? undefined : agentById(cachedId);
  if (cached !== undefined) return withCommand(cached);
  const chosen = chooseAgent();
  return withCommand(chosen);
}

function withCommand(agent: Agent): Agent {
  resolved ??= agent.command;
  return agent;
}

/** Test seam: forget the cached command so a new choice takes effect. */
export function resetAgentCommand(): void {
  resolved = null;
}

export { DEFAULT_AGENT_ID, writeUserAgent };

/**
 * Runs the agent phase (async, so the orchestrator's HTTP server stays live
 * and mid-phase client calls succeed), tees the transcript to the pass log,
 * then takes the verdict. There are exactly two delivery channels, and the
 * outcome is instrumented per phase: an `iteration submit-verdict` submission
 * wins; otherwise the printed output is scanned for a line that parses as a
 * JSON object. On failure the agent is re-run (up to VERDICT_ATTEMPT_LIMIT)
 * with the failure reason and both delivery modes restated; exhausting the
 * limit throws (a logged hard failure — never silently skipped).
 */
export const VERDICT_ATTEMPT_LIMIT = 12;

/** How much of the previous transcript a retry note carries back to the agent. */
export const RETRY_OUTPUT_TAIL_CHARS = 4000;

export async function agent<T>(title: string, prompt: string, validate: Validator, retrySchema: string): Promise<T> {
  log(`phase: ${title}`);
  let attempt = 0;
  let lastReason = 'no attempt made yet';
  let lastOutput = '';
  while (attempt < VERDICT_ATTEMPT_LIMIT) {
    attempt += 1;
    const retry = attempt === 1 ? '' : retryNote(title, lastReason, lastOutput, retrySchema);
    const output = await runAgentRaw(title, `${prompt}${retry}`);
    const submitted = takeSubmittedVerdict(title);
    if (submitted !== null) {
      const submissionErr = validate(submitted);
      if (submissionErr === null) {
        recordVerdictOutcome(title, 'submit-verdict', attempt);
        log(`phase ${title}: verdict accepted via submit-verdict (attempt ${attempt})`);
        return submitted as T;
      }
      log(`phase ${title}: submitted verdict rejected (${submissionErr})`);
    }
    const fromOutput = check(output, validate);
    if (fromOutput.ok) {
      recordVerdictOutcome(title, 'final-line', attempt);
      log(`phase ${title}: verdict accepted via final-line output (attempt ${attempt})`);
      return fromOutput.value as T;
    }
    const reasons = [
      ...(submitted !== null ? ['a submitted verdict was rejected'] : []),
      fromOutput.reason,
    ];
    lastReason = reasons.join('; ');
    lastOutput = output;
    log(`phase ${title}: ${lastReason} (attempt ${attempt}/${VERDICT_ATTEMPT_LIMIT})`);
  }
  throw new Error(`phase ${title}: no valid verdict after ${VERDICT_ATTEMPT_LIMIT} attempts (last: ${lastReason})`);
}

function retryNote(title: string, reason: string, lastOutput: string, retrySchema: string): string {
  const tail =
    lastOutput.length > RETRY_OUTPUT_TAIL_CHARS
      ? '…' + lastOutput.slice(-RETRY_OUTPUT_TAIL_CHARS)
      : lastOutput;
  const last = tail ? `Your previous reply was: ${tail}` : '';
  return `${last}
Your previous reply was rejected: ${reason}
Deliver your verdict by running 'iteration submit-verdict ${title} <json>' (preferred,
mid-phase), with the output printed as a single-line JSON object as fallback.
The fallback final line MUST be a single JSON object matching: ${retrySchema}`;
}

function check(
  output: string,
  validate: Validator,
): { ok: boolean; value?: unknown; reason: string } {
  const verdict = extractJsonVerdict(output);
  if (verdict === null) return { ok: false, reason: 'no parsable JSON verdict' };
  const err = validate(verdict);
  if (err !== null) return { ok: false, reason: `invalid verdict (${err})` };
  return valid(verdict);
}

function valid(value: unknown): { ok: boolean; value: unknown; reason: string } {
  return { ok: true, value, reason: '' };
}

export async function runAgentRaw(title: string, prompt: string): Promise<string> {
  const cmd = agentCommand();
  let out = '';
  fs.mkdirSync(logDir(), { recursive: true });
  // The phase transcript streams into the log as the child emits it: a harness
  // that dies mid-phase (signal, crash) must leave an accurate trail of how
  // far the phase got, not a silently empty block.
  fs.appendFileSync(logFile(), `----- phase ${title} -----\n`);
  let chunks = 0;
  let endedWithNewline = true;
  try {
    out = await execPrompt(cmd, title, prompt, (c) => {
      chunks += 1;
      endedWithNewline = c.endsWith('\n');
      fs.appendFileSync(logFile(), stripAnsi(c));
    });
  } catch (err) {
    log(`${cmd[0]} phase ${title} exited non-zero`);
    out = String((err as { stdout?: unknown }).stdout ?? '');
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr !== '') log(`${cmd[0]} phase ${title} stderr: ${stripAnsi(stderr)}`);
  }
  fs.appendFileSync(logFile(), `${endedWithNewline || chunks === 0 ? '' : '\n'}----- end ${title} -----\n`);
  return out;
}

const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]|\r/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Prompts go over stdin, not argv: argv hits the kernel's exec argument limit
 * (`ENAMETOOLONG`) on long prompts like a full-issue triage. `opencode run`
 * reads a piped, non-TTY stdin as the message.
 */
export const IDLE_TIMEOUT_SECS = idleTimeoutSecs();

function idleTimeoutSecs(): number {
  const raw = Number(process.env.ITERATION_IDLE_TIMEOUT_SECS ?? '300');
  return Number.isFinite(raw) && raw > 0 ? raw : 60;
}

/**
 * Agents are killed after no output for IDLE_TIMEOUT_SECS: some (e.g.
 * `opencode run` after printing its final message) never exit on their own,
 * and the harness must not wedge on a finished-but-hung child. The child runs
 * detached so the whole process group can be signalled: CLIs like `opencode`
 * spawn inner children that keep running after the parent dies, which pins
 * the stdio pipes (no `close` event) and can leave the attempt unsettled.
 * After the force-kill the promise is settled from captured output.
 */
function execPrompt(
  cmd: string[],
  title: string,
  prompt: string,
  onStdout: (chunk: string) => void = () => {},
): Promise<string> {
  const idleMs = IDLE_TIMEOUT_SECS * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, ITERATION_PHASE: title },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let settled = false;
    let stdout = '';
    let stderr = '';
    let idle: NodeJS.Timeout | null = setInterval(() => {
      log(`${cmd[0]} phase ${title}: no output for ${IDLE_TIMEOUT_SECS}s; killing (timeout)`);
      if (idle) {
        clearInterval(idle);
        idle = null;
      }
      const pid = child.pid;
      const signalGroup = (signal: NodeJS.Signals): void => {
        child.kill(signal);
        if (pid === undefined) return;
        try {
          process.kill(-pid, signal);
        } catch {
          /* group already gone */
        }
      };
      signalGroup('SIGTERM');
      setTimeout(() => {
        signalGroup('SIGKILL');
        settle(false, Object.assign(new Error('idle timeout; killed'), { stdout, stderr }));
      }, 5000).unref();
    }, idleMs);
    const armIdle = (): void => {
      idle?.refresh();
    };
    const settle = (ok: boolean, err: Error & { stdout: string; stderr: string }): void => {
      if (settled) return;
      settled = true;
      if (idle) clearInterval(idle);
      ok ? resolve(stdout) : reject(err);
    };
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      stdout += s;
      armIdle();
      onStdout(s);
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
      armIdle();
    });
    child.on('error', (err) => {
      settle(false, Object.assign(err as Error & { stdout: string; stderr: string }, { stdout, stderr }));
    });
    child.on('close', (code) => {
      settle(
        code === 0,
        Object.assign(new Error(`exit ${code}`), { stdout, stderr }),
      );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
