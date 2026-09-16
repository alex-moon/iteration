import type { LoopState, Repo } from './types';
import { client } from './octokit';
import { log } from './log';
import { loadLoopState, writeLoopState, clearShutdown } from './loop-state';
import { sleepSeconds } from './shell';
import { PASS_INTERVAL } from './config';
import { setStatus } from './status';

interface ActivityFingerprint {
  items: Record<string, number>;
  reviewComments: number;
}

/**
 * Deterministic GitHub activity fingerprint: comment counts of every open
 * issue and PR, plus the total count of PR review comments. Edits to
 * existing items change none of these, so they cannot trigger a wake.
 */
export async function fetchActivity(repo: Repo): Promise<string | null> {
  try {
    const items: Record<string, number> = {};
    for (let page = 1; ; page++) {
      const { data } = await client().rest.issues.listForRepo({
        owner: repo.owner,
        repo: repo.name,
        state: 'open',
        per_page: 100,
        page,
      });
      for (const i of data) items[String(i.number)] = i.comments ?? 0;
      if (data.length < 100) break;
    }
    let reviewComments = 0;
    for (let page = 1; ; page++) {
      const { data } = await client().rest.pulls.listReviewCommentsForRepo({
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
        page,
      });
      reviewComments += data.length;
      if (data.length < 100) break;
    }
    const fp: ActivityFingerprint = { items, reviewComments };
    return JSON.stringify(fp);
  } catch (err) {
    log(`activity fetch failed: ${(err as Error).message}`);
    return null;
  }
}

/** Describes the first difference between two fingerprints, or null if equal. */
export function activityChange(current: string, baseline: string): string | null {
  const parse = (s: string): ActivityFingerprint => {
    const raw = JSON.parse(s) as Partial<ActivityFingerprint>;
    return { items: raw.items ?? {}, reviewComments: raw.reviewComments ?? 0 };
  };
  const cur = parse(current);
  const base = parse(baseline);
  for (const [n, comments] of Object.entries(base.items)) {
    if (!(n in cur.items)) return `#${n} closed`;
    const curCount = cur.items[n];
    if (curCount !== undefined && curCount > comments) {
      return `#${n} gained ${curCount - comments} comment(s)`;
    }
  }
  for (const n of Object.keys(cur.items)) {
    if (!(n in base.items)) return `#${n} is new`;
  }
  if (cur.reviewComments > base.reviewComments) {
    return `PR review comments went ${base.reviewComments} -> ${cur.reviewComments}`;
  }
  return null;
}

/**
 * Sleep mode for a shutdown in effect: poll GitHub for meaningful new
 * activity each PASS_INTERVAL; the first poll records the baseline. Returns
 * only when new activity wakes the loop (shutdown cleared).
 */
export async function sleepUntilActivity(repo: Repo): Promise<void> {
  while (true) {
    sleepSeconds(PASS_INTERVAL);
    const current = await fetchActivity(repo);
    if (current === null) continue;
    const state: LoopState | null = loadLoopState();
    if (state === null || state.mode !== 'decision') return;
    if (state.activity === null) {
      writeLoopState(state.strikes, state.mode, state.decidedAt, state.reason, current);
      const fp = JSON.parse(current) as ActivityFingerprint;
      log(`Sleep mode: activity baseline recorded (${Object.keys(fp.items).length} open items, ${fp.reviewComments} PR review comments)`);
      continue;
    }
    const change = activityChange(current, state.activity);
    if (change === null) {
      setStatus({ phase: 'sleep', mode: 'dormant', repo: repo.fullName });
      continue;
    }
    log(`New GitHub activity while dormant: ${change} - restarting the iteration loop`);
    clearShutdown();
    return;
  }
}
