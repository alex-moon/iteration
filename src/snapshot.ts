import fs from 'node:fs';
import path from 'node:path';
import type { IssueInfo, PassSnapshot, PlanDoc, Repo } from './types';
import { fetchIssues, fetchOpenPrs, fetchPendingReviewComments } from './github';
import { log } from './log';

let snapshot: PassSnapshot | null = null;

export function passSnapshot(): PassSnapshot | null {
  return snapshot;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function readPlanDocs(issues: IssueInfo[]): PlanDoc[] {
  const docsDir = 'docs';
  if (!fs.existsSync(docsDir)) return [];
  const byIssue = new Set(issues.map((i) => i.number));
  const out: PlanDoc[] = [];
  const files = fs
    .readdirSync(docsDir)
    .filter((f) => f.startsWith('plan-') && f.endsWith('.md'))
    .sort();
  for (const f of files) {
    const m = /^plan-(\d+)-.*\.md$/.exec(f);
    if (!m) continue;
    const issue = Number(m[1]);
    if (!byIssue.has(issue)) continue;
    out.push({
      issue,
      file: path.join(docsDir, f),
      content: fs.readFileSync(path.join(docsDir, f), 'utf8'),
    });
  }
  return out;
}

export async function gatherSnapshot(repo: Repo, issues?: IssueInfo[]): Promise<PassSnapshot> {
  // The warmed ticket cache already fetched the issue list once per pass; a
  // preset issues array skips the duplicate list+comments round-trip.
  const resolvedIssues = issues ?? (await fetchIssues(repo));
  const openPrs = await fetchOpenPrs(repo);
  return {
    gatheredAt: nowIso(),
    issues: resolvedIssues,
    openPrs,
    pendingReviewComments: await fetchPendingReviewComments(repo, openPrs.map((p) => p.number)),
    planDocs: readPlanDocs(resolvedIssues),
  };
}

export function refreshPlanDoc(issue: number): void {
  if (snapshot === null) return;
  const fresh = readPlanDocs([{ number: issue, title: '', updatedAt: '', comments: [] }]);
  if (fresh.length === 0) return;
  const doc = snapshot.planDocs.find((d) => d.issue === issue);
  if (doc) {
    doc.file = fresh[0] !== undefined ? fresh[0].file : doc.file;
    doc.content = fresh[0]?.content ?? doc.content;
  } else {
    snapshot.planDocs.push(...fresh);
  }
}

export function planDocFor(issue: number): PlanDoc | null {
  return snapshot?.planDocs.find((d) => d.issue === issue) ?? null;
}

export function setGatheredSnapshot(s: PassSnapshot): void {
  snapshot = s;
  log(
    `Snapshot gathered: ${s.issues.length} open issues, ${s.openPrs.length} open PRs at ${s.gatheredAt}`,
  );
}
