/**
 * Per-phase verdicts submitted by agents over `iteration submit-verdict`.
 * agent() honors these in preference to parsing the phase transcript: a
 * submitted verdict wins, the final printed line is only a fallback.
 */

const submitted: Map<string, string> = new Map();

export function recordSubmittedVerdict(phase: string, verdict: string): void {
  submitted.set(phase, verdict);
}

export function takeSubmittedVerdict(phase: string): string | null {
  const v = submitted.get(phase);
  if (v === undefined) return null;
  submitted.delete(phase);
  try {
    return JSON.parse(v) as string;
  } catch {
    return v;
  }
}
