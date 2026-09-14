import fs from 'node:fs';
import path from 'node:path';
import type { IssueComment, IssueInfo, PassSnapshot, PlanDoc, Repo } from './types';
import { fetchIssues, fetchOpenPrs, fetchPendingReviewComments } from './github';
import { log } from './log';

let snapshot: PassSnapshot | null = null;

export function passSnapshot(): PassSnapshot | null {
  return snapshot;
}

function nowIso(): string {
  return new Date().toISOString();
}

export const ITERATION_DIR = '.iteration';
export const PLAN_DOCS_DIR = path.join(ITERATION_DIR, 'docs');

export function readPlanDocs(issues: IssueInfo[]): PlanDoc[] {
  if (!fs.existsSync(PLAN_DOCS_DIR)) return [];
  const byIssue = new Set(issues.map((i) => i.number));
  const out: PlanDoc[] = [];
  const files = fs
    .readdirSync(PLAN_DOCS_DIR)
    .filter((f) => f.startsWith('plan-') && f.endsWith('.md'))
    .sort();
  for (const f of files) {
    const m = /^plan-(\d+)-.*\.md$/.exec(f);
    if (!m) continue;
    const issue = Number(m[1]);
    if (!byIssue.has(issue)) continue;
    out.push({
      issue,
      file: path.join(PLAN_DOCS_DIR, f),
      content: fs.readFileSync(path.join(PLAN_DOCS_DIR, f), 'utf8'),
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
  const fresh = readPlanDocs([{ number: issue, title: '', updatedAt: '', body: '', comments: [] }]);
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

function renderComments(comments: IssueComment[]): string {
  if (comments.length === 0) return '    (no comments)';
  return comments
    .map((c) => `    - ${c.by} at ${c.at}: ${c.body.replace(/\n/g, ' | ')}`)
    .join('\n');
}

/** Full frozen snapshot, injected inline into the triage prompt. */
export function snapshotText(): string {
  const s = snapshot;
  if (s === null) return '(no snapshot gathered yet)';
  const issues = s.issues
    .map(
      (i) =>
        `- #${i.number} "${i.title}" (updated ${i.updatedAt})\n` +
        `    Body: ${i.body.replace(/\n/g, ' | ')}\n` +
        renderComments(i.comments),
    )
    .join('\n');
  const prs =
    s.openPrs.length === 0
      ? '(no open PRs)'
      : s.openPrs.map((p) => `- PR #${p.number} "${p.title}" (head ${p.headRefName})`).join('\n');
  const plans =
    s.planDocs.length === 0
      ? '(no plan docs on disk)'
      : s.planDocs.map((d) => `- ${d.file}`).join('\n');
  return `OPEN ISSUES (with full comment conversations):\n${issues}\nOPEN PRs:\n${prs}\nPLAN DOCS ON DISK:\n${plans}`;
}

/** Everything for a single ticket, injected inline into its dedicated phases. */
export function ticketText(issue: number): string {
  const s = snapshot;
  const i = s?.issues.find((x) => x.number === issue);
  if (s === null || i === undefined) return `(ticket #${issue} not in the current snapshot)`;
  const prs = s.openPrs.filter((p) => p.headRefName.split('-')[0]?.includes(String(issue)));
  return `TICKET #${issue} "${i.title}" (updated ${i.updatedAt})
Body:
${i.body}
Comments:
${renderComments(i.comments)}${prs.length > 0 ? `\nOpen PRs: ${prs.map((p) => `#${p.number} "${p.title}" (${p.headRefName})`).join(', ')}` : ''}`;
}
