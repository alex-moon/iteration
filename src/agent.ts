import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { LOG_FILE, log } from './log';
import type { Validator } from './verdicts';
import { extractJsonVerdict } from './verdicts';

/**
 * Runs `opencode run --auto --title <title> <prompt>`, tees the transcript
 * to the pass log, then extracts and validates the final JSON verdict. On
 * invalid output the agent is retried exactly once with the schema included;
 * a second failure throws (a logged hard failure — never silently skipped).
 */
export function agent<T>(title: string, prompt: string, validate: Validator, retrySchema: string): T {
  log(`phase: ${title}`);
  let output = runAgentRaw(title, prompt);
  let verdict = extractJsonVerdict(output);
  if (verdict !== null) {
    const err = validate(verdict);
    if (err === null) return verdict as T;
    log(`phase ${title}: invalid verdict (${err}); one retry with schema`);
    output = runAgentRaw(
      title,
      `${prompt}\n\nYour previous reply was rejected: ${err}\nFinal line MUST be a single JSON object matching: ${retrySchema}`,
    );
    verdict = extractJsonVerdict(output);
    if (verdict === null) throw new Error(`phase ${title}: retry produced no JSON verdict`);
    const err2 = validate(verdict);
    if (err2 !== null) throw new Error(`phase ${title}: retry verdict still invalid (${err2})`);
    return verdict as T;
  }
  log(`phase ${title}: no JSON verdict in output; one retry with schema`);
  output = runAgentRaw(
    title,
    `${prompt}\n\nYour previous reply had no parsable JSON verdict.\nFinal line MUST be a single JSON object matching: ${retrySchema}`,
  );
  verdict = extractJsonVerdict(output);
  if (verdict === null) throw new Error(`phase ${title}: retry produced no JSON verdict`);
  const err3 = validate(verdict);
  if (err3 !== null) throw new Error(`phase ${title}: retry verdict invalid (${err3})`);
  return verdict as T;
}

export function runAgentRaw(title: string, prompt: string): string {
  let out = '';
  try {
    out = execFileSync('opencode', ['run', '--auto', '--title', title, prompt], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    log(`opencode phase ${title} exited non-zero`);
    out = String((err as { stdout?: unknown }).stdout ?? '');
  }
  fs.appendFileSync(LOG_FILE, `----- phase ${title} -----\n${out}\n----- end ${title} -----\n`);
  return out;
}
