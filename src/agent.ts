import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logDir, logFile, log } from './log';
import type { Validator } from './verdicts';
import { extractJsonVerdict } from './verdicts';
import { takeSubmittedVerdict } from './submit-state';
import { recordVerdictOutcome } from './verdict-stats';

/**
 * The agent binary is injectable so mock runs never spawn a real agent:
 * ITERATION_AGENT_CMD holds the full command line ("node mock-agent.js ..."),
 * defaulting to `opencode run`.
 */
export function agentCommand(): string[] {
  const spec = process.env.ITERATION_AGENT_CMD;
  return spec === undefined || spec.trim() === '' ? ['opencode', 'run'] : spec.split(' ').filter(Boolean);
}

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

export async function agent<T>(title: string, prompt: string, validate: Validator, retrySchema: string): Promise<T> {
  log(`phase: ${title}`);
  let attempt = 0;
  let lastReason = 'no attempt made yet';
  while (attempt < VERDICT_ATTEMPT_LIMIT) {
    attempt += 1;
    const retry = attempt === 1 ? '' : retryNote(title, lastReason, retrySchema);
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
    log(`phase ${title}: ${lastReason} (attempt ${attempt}/${VERDICT_ATTEMPT_LIMIT})`);
  }
  throw new Error(`phase ${title}: no valid verdict after ${VERDICT_ATTEMPT_LIMIT} attempts (last: ${lastReason})`);
}

function retryNote(title: string, reason: string, retrySchema: string): string {
  return `
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
  try {
    out = await execPrompt(cmd, title, prompt);
  } catch (err) {
    log(`${cmd[0]} phase ${title} exited non-zero`);
    out = String((err as { stdout?: unknown }).stdout ?? '');
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    if (stderr !== '') log(`${cmd[0]} phase ${title} stderr: ${stderr}`);
  }
  fs.mkdirSync(logDir(), { recursive: true });
  fs.appendFileSync(logFile(), `----- phase ${title} -----\n${out}\n----- end ${title} -----\n`);
  return out;
}

/**
 * Prompts go over stdin, not argv: argv hits the kernel's exec argument limit
 * (`ENAMETOOLONG`) on long prompts like a full-issue triage. `opencode run`
 * reads a piped, non-TTY stdin as the message.
 */
function execPrompt(cmd: string[], title: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      env: { ...process.env, ITERATION_PHASE: title },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(Object.assign(new Error(`exit ${code}`), { stdout, stderr })),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}
