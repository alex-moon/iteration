import fs from 'node:fs';
import path from 'node:path';
import type { IssueInfo, PassSnapshot, PlanDoc, Repo } from './types';
import { fetchIssues, fetchOpenPrs, fetchPendingReviewComments } from './github';
import { log } from './log';

let snapshot: PassSnapshot | null = null;

export function currentSnapshot(): PassSnapshot | null {
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

export function gatherSnapshot(repo: Repo): PassSnapshot {
  const issues = fetchIssues(repo);
  const openPrs = fetchOpenPrs(repo);
  return {
    gatheredAt: nowIso(),
    issues,
    openPrs,
    pendingReviewComments: fetchPendingReviewComments(repo, openPrs.map((p) => p.number)),
    planDocs: readPlanDocs(issues),
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

function snapshotPromptText(issue: number | null): string {
  if (snapshot === null) {
    return 'PASS SNAPSHOT unavailable; re-fetch whatever you need with gh.\n';
  }
  const issues = issue === null ? snapshot.issues : snapshot.issues.filter((i) => i.number === issue);
  // Branch naming is per-repo; matching on the issue number keeps it repo-agnostic.
  const prs =
    issue === null
      ? snapshot.openPrs
      : snapshot.openPrs.filter((p) => p.headRefName.includes(`${issue}-`));
  const prNumbers = new Set(prs.map((p) => p.number));
  const pending = snapshot.pendingReviewComments.filter((c) => prNumbers.has(c.pr));
  const plans = issue === null ? snapshot.planDocs : snapshot.planDocs.filter((d) => d.issue === issue);
  return [
    `PASS SNAPSHOT (gathered ${snapshot.gatheredAt}) — this is the state gathered once per pass;`,
    'do not re-fetch it; individual gh calls for anything else you need remain available.',
    `openIssues=${JSON.stringify(issues)}`,
    `openPrs=${JSON.stringify(prs)}`,
    `pendingReviewComments=${JSON.stringify(pending)}`,
    `planDocs=${JSON.stringify(plans)}`,
    '',
  ]
    .join('\n')
    .trim();
}

export function snapshotBlock(issue: number | null): string {
  return `PASS SNAPSHOT delivered below. The harness gathered it once this pass; phases must
not re-run the same list gh calls (individual gh calls for anything unfinished keep working).

${snapshotPromptText(issue)}`;
}

export function setGatheredSnapshot(s: PassSnapshot): void {
  snapshot = s;
  log(
    `Snapshot gathered: ${s.issues.length} open issues, ${s.openPrs.length} open PRs at ${s.gatheredAt}`,
  );
}
