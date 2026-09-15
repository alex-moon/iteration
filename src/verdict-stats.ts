import fs from 'node:fs';
import path from 'node:path';
import { logDir } from './log';

export type VerdictMode = 'submit-verdict' | 'final-line';

interface PhaseStats {
  submitVerdict: number;
  finalLine: number;
  totalAttempts: { submitVerdict: number; finalLine: number };
}

const statsFile = () => path.join(logDir(), 'verdict-stats.json');

/**
 * Aggregates, per phase and across runs, which of the two verdict delivery
 * channels ("iteration submit-verdict" vs the parsed final line) agents actually
 * use and how many attempts each needed. Diagnostics only; never fatal.
 */
export function recordVerdictOutcome(
  phase: string,
  mode: VerdictMode,
  attempts: number,
): void {
  try {
    const all: Record<string, PhaseStats> = fs.existsSync(statsFile())
      ? JSON.parse(fs.readFileSync(statsFile(), 'utf8'))
      : {};
    const s = all[phase] ?? {
      submitVerdict: 0,
      finalLine: 0,
      totalAttempts: { submitVerdict: 0, finalLine: 0 },
    };
    if (mode === 'submit-verdict') {
      s.submitVerdict += 1;
      s.totalAttempts.submitVerdict += attempts;
    } else {
      s.finalLine += 1;
      s.totalAttempts.finalLine += attempts;
    }
    all[phase] = s;
    fs.mkdirSync(logDir(), { recursive: true });
    fs.writeFileSync(statsFile(), JSON.stringify(all, null, 2));
  } catch (err) {
    console.error(`[verdict-stats] failed to persist: ${(err as Error).message}`);
  }
}

export function readVerdictStats(): Record<string, PhaseStats> {
  try {
    return JSON.parse(fs.readFileSync(statsFile(), 'utf8'));
  } catch {
    return {};
  }
}
