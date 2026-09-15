import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { logDir, logFile, log } from './log';
import type { Validator } from './verdicts';
import { extractJsonVerdict } from './verdicts';
import { takeSubmittedVerdict } from './submit-state';

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
 * then validates the final JSON verdict. A verdict already submitted over
 * `iteration submit-verdict` takes precedence. On invalid output the agent is
 * retried exactly once with the schema included; a second failure throws
 * (a logged hard failure — never silently skipped).
 */
export async function agent<T>(title: string, prompt: string, validate: Validator, retrySchema: string): Promise<T> {
  log(`phase: ${title}`);
  const submitted = takeSubmittedVerdict(title);
  if (submitted !== null) {
    const submittedErr = validate(submitted);
    if (submittedErr === null) {
      log(`phase ${title}: using verdict submitted via the orchestrator`);
      return submitted as T;
    }
    log(`phase ${title}: submitted verdict rejected (${submittedErr}); parsing phase output`);
  }

  let output = await runAgentRaw(title, prompt);
  // A verdict submitted over `iteration submit-verdict` during the phase call wins.
  const midSubmission = takeSubmittedVerdict(title);
  if (midSubmission !== null) log(`phase ${title}: verdict submitted via the orchestrator`);
  const first =
    midSubmission !== null ? finalize(midSubmission, validate) : check(output, validate);
  if (first.ok) return first.value as T;
  log(`phase ${title}: ${first.reason}; one retry with schema`);
  output = await runAgentRaw(
    title,
    `${prompt}\n\nYour previous reply failed: ${first.reason}\nFinal line MUST be a single JSON object matching: ${retrySchema}`,
  );
  const second = check(output, validate);
  if (second.ok) return second.value as T;
  const midRetrySubmission = takeSubmittedVerdict(title);
  if (midRetrySubmission !== null) {
    const finalVerdict = finalize(midRetrySubmission, validate);
    if (finalVerdict.ok) {
      log(`phase ${title}: retry verdict submitted via the orchestrator`);
      return finalVerdict.value as T;
    }
    throw new Error(`phase ${title}: retry also invalid (${finalVerdict.reason})`);
  }
  throw new Error(`phase ${title}: retry also invalid (${second.reason})`);
}

function finalize(
  value: unknown,
  validate: Validator,
): { ok: boolean; value?: unknown; reason: string } {
  const err = validate(value);
  if (err !== null) return { ok: false, reason: `invalid verdict (${err})` };
  return { ok: true, value, reason: '' };
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
