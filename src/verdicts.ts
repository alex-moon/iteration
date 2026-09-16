import { LOOP_DECISION_SCHEMA, TRIAGE_SCHEMA } from './types';

export type Validator = (v: unknown) => string | null;

/** Extract the last line of the output that parses as a JSON object. */
export function extractJsonVerdict(output: string): unknown | null {
  const lines = output.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i];
    if (t === undefined) continue;
    const trimmed = t.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // keep scanning backwards
    }
  }
  return null;
}

export function validateTriage(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return 'not a JSON object';
  if (r.kind === 'none') return null;
  if (r.kind === 'issue') {
    const n = asNum(r.issue);
    if (n === null || n <= 0) return '"issue" must be a positive integer when "kind" is "issue"';
    return null;
  }
  return `expected ${TRIAGE_SCHEMA}`;
}

export function validateLoopDecision(v: unknown): string | null {
  const r = asRecord(v);
  if (!r) return 'not a JSON object';
  if (r.decision === 'CONTINUE') return null;
  if (r.decision === 'END' && asStr(r.reason) !== null) return null;
  return `expected ${LOOP_DECISION_SCHEMA}`;
}

export function acceptAnyObject(v: unknown): string | null {
  if (asRecord(v) === null) return 'not a JSON object';
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}
