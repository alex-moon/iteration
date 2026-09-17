import type { LoopDecisionVerdict, Repo, TriageVerdict } from './types';
import { LOOP_DECISION_SCHEMA, TRIAGE_SCHEMA } from './types';

import { log } from './log';
import { STRIKE_LIMIT, getPriority } from './config';
import { acceptAnyObject, validateLoopDecision, validateTriage } from './verdicts';
import { agent } from './agent';
import { addStrike } from './loop-state';
import {
  PLAN_DOCS_DIR,

  passSnapshot,
  gatherSnapshot,
  planDocFor,
  refreshPlanDoc,
  setGatheredSnapshot,
  snapshotText,
  ticketText,
} from './snapshot';
import { flushComments } from './comments';
import { fetchIssueTitle, fetchPendingReviewComments } from './github';
import { createDraftPr, openPrForBranch } from './octokit';
import { stateCommandsBlock } from './wiring';
import {
  addAllAndCommit,
  addPathAndCommit,
  checkoutBranch,
  discardLocalChanges,
  hasChanges,
  hasPathChanges,
  hasCommitsSinceFork,
  listBranches,
  currentBranch as currentBranchName,
  pullBranch,
  pushBranch,
  repoRoot,
} from './git-client';
import { warmTicketCache } from './orchestrator';
import { checkpointEx, CancelledError } from './control';
import { setStatus } from './status';

let currentBranch = 'main';
let repo: Repo;

export function setRepo(r: Repo): void {
  repo = r;
}

export function repoInfo(): Repo {
  return repo;
}

// ---- Git helpers ---------------------------------------------------------------------





async function commitAndPush(msg: string): Promise<void> {
  if (await hasChanges()) {
    await addAllAndCommit(msg);
    await pushBranch(currentBranch);
    log(`Committed and pushed: ${msg}`);
  } else {
    log(`Nothing to commit for: ${msg}`);
  }
}

async function commitPlan(issue: number): Promise<void> {
  if (!(await hasPathChanges(PLAN_DOCS_DIR))) {
    log('No plan changes to commit');
    return;
  }
  await addPathAndCommit(PLAN_DOCS_DIR, `.iteration: plan updates for #${issue}`);
  await pushBranch(currentBranch);
  log('Committed and pushed plan updates');
  refreshPlanDoc(issue);
}

async function ensureDraftPr(issue: number): Promise<void> {
  const existing = await openPrForBranch(repo, currentBranch);
  if (existing !== null) return;
  const title = await fetchIssueTitle(repo, issue);
  await createDraftPr(repo, currentBranch, issue, title, planDocFor(issue)?.file ?? null);
}

// ---- Shared prompt frame ---------------------------------------------------------------

async function contextPrefix(issue: number, phase: string): Promise<string> {
  const root = await repoRoot();
  return `You are working in the repo ${root} on branch ${currentBranch} for GitHub issue #${issue}
in ${repo.fullName}.
CONTEXT INJECTION (frozen snapshot from the orchestrator, gathered this pass; do not re-read
GitHub - everything about THIS ticket is below):
${ticketText(issue)}
${stateCommandsBlock(phase, issue, repo)}
Follow the repo's existing conventions. Do NOT commit or push - the orchestrator does that.
Before doing anything, confirm from the injected state that this ticket is neither already
done nor blocked on the user: if it is, run
'iteration queue-comment ${issue} "<blocking reason>"' and stop immediately without doing any work.
`;
}

// ---- Triage phase -----------------------------------------------------------------------

function triagePrompt(): string {
  const priority = getPriority();
  const priorityNote =
    priority !== undefined
      ? `
The user has marked issue #${priority} as PRIORITY. Prefer it: if it is READY, pick it even
if other issues are smaller or more recently updated. You MAY pick a different issue only
when it directly supports the priority ticket (unblocks it or delivers a prerequisite the
priority ticket depends on) - in that case output the supporting issue's number. If the
priority issue is DONE or BLOCKED, classify it exactly as you would any other ticket.
`
      : '';
  return `You are triaging the open GitHub issues for repo ${repo.fullName} and picking the
next one to work on. Do NOT trust issue state alone: judge each ticket from the captured
state below. CONTEXT INJECTION (frozen snapshot, gathered this pass - you do NOT need
to re-run gh issue list / gh pr list, and you do NOT need get-ticket):
${snapshotText()}
${stateCommandsBlock('triage-tickets', null, repo)}
1. Classify each issue as exactly one of:
   - DONE:   the deliverable exists and is verified (green PR/checks or work landed on main);
              a branch whose name contains the ticket number carrying the deliverable with an
              open PR against main means the ticket is in review or done.
   - BLOCKED: progress requires something only the user can provide - an unanswered open
              question, an access request, or a decision the repo gives no basis to make.
   - READY:  work is possible now that could move the ticket forward.
   If an issue is BLOCKED and has no comment already stating that, queue it via
   'iteration queue-comment <n> "<reason and what would unblock it>"' (once per ticket;
   if an identical comment already exists in the injected thread, do not queue again).
2. If every open issue is DONE or BLOCKED, your final line is {"kind":"none"}.
3. Otherwise pick ONE issue: prefer tickets whose comments contain answers to previously
   raised open questions, then smaller well-scoped READY issues over sprawling ones.
   Never pick a DONE ticket, and never pick a BLOCKED ticket.
4. Final line MUST be the single JSON object: ${TRIAGE_SCHEMA}`;
}

export async function triagePhase(): Promise<TriageVerdict> {
  const v = await agent<TriageVerdict>(
    'triage-tickets',
    triagePrompt(),
    validateTriage,
    TRIAGE_SCHEMA,
  );
  const snapshot = passSnapshot();
  if (v.kind === 'issue' && snapshot !== null && !snapshot.issues.some((i) => i.number === v.issue)) {
    throw new Error(`triage returned issue ${v.issue} which is not in the current snapshot`);
  }
  return v;
}

// ---- Branch helpers ------------------------------------------------------------------------

export async function ensureBranch(issue: number): Promise<string> {
  const branches = await listBranches();
  // Match on the issue number so the convention stays repo-agnostic.
  const match = branches.find((b) => b.includes(`/${issue}-`));
  if (match) {
    const branch = match.replace(/^origin\//, '');
    await checkoutBranch(branch);
    const pulledOk = await pullBranch(branch);
    if (!pulledOk && (await currentBranchName()) !== branch) {
      log('pull failed; continuing with local state');
    }
    return branch;
  }
  const title = await fetchIssueTitle(repo, issue);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .join('-');
  const summary = words === '' ? 'iteration' : words;
  const branch = `feat/${issue}-${summary}`;
  const local = branches.find((b) => !b.startsWith('origin/') && b === branch);
  if (local) {
    await checkoutBranch(branch);
    const pulledOk = await pullBranch(branch);
    if (!pulledOk && (await currentBranchName()) !== branch) {
      log('pull failed; continuing with local state');
    }
    return branch;
  }
  await checkoutBranch(branch, 'origin/main');
  log(`Created branch ${branch}`);
  return branch;
}

// ---- Pass body -------------------------------------------------------------------------------

export interface PassOutcome {
  productive: boolean;
  stop: boolean;
  cancelled?: boolean;
}

function statusFor(phase: string, issue: number | null, pr: string | null = null): void {
  const snapshot = passSnapshot();
  const info = snapshot?.issues.find((i) => i.number === issue);
  setStatus({
    phase,
    mode: 'running',
    repo: repo.fullName,
    number: issue,
    title: info?.title ?? null,
    branch: issue === null ? null : currentBranch,
    pr,
  });
}

/** Honor pause/cancel at a phase boundary, then publish what is about to run. */
async function startPhase(phase: string, issue: number | null, pr: string | null = null): Promise<void> {
  checkpointEx();
  statusFor(phase, issue, pr);
}

export async function runPass(): Promise<PassOutcome> {
  const warmedIssues = await warmTicketCache(repo);
  setGatheredSnapshot(await gatherSnapshot(repo, warmedIssues));
  statusFor('triage-tickets', null);

  // ---- Phase 0: triage ----
  const pick = await triagePhase();
  if (pick.kind === 'none') {
    log('Triage verdict: none');
    await flushComments(repo);
    if (!addStrike('strikes', 'triage returned ISSUE:NONE')) {
      log(
        `Triage found nothing to do for ${STRIKE_LIMIT} consecutive passes; entering dormant sleep mode`,
      );
      return { productive: false, stop: true };
    }
    return { productive: false, stop: false };
  }
  const ISSUE = pick.issue;
  log(`Triage verdict: ISSUE:${ISSUE}`);
  statusFor(`triage-tickets (picked #${ISSUE})`, ISSUE);

  // ---- Branch ----
  if (await hasChanges()) {
    log('Leftover local changes in worktree; discarding before branch setup');
    await discardLocalChanges();
  }
  currentBranch = await ensureBranch(ISSUE);
  refreshPlanDoc(ISSUE);
  log(`Working branch: ${currentBranch}`);
  statusFor('branch-setup', ISSUE);

  // ---- Phase 1: plan-write ----
  const plan = planDocFor(ISSUE);
  if (plan === null) {
    await startPhase('plan-write', ISSUE);
    await agent<unknown>(
      'plan-write',
      `${await contextPrefix(ISSUE, "plan-write")}

Write a plan at .iteration/docs/plan-${ISSUE}-<summary>.md (summary matches the branch name suffix). It
must be:
a) detailed: a motivation section linking the issue, decisions so far, and a checklist of
   small tasks each safely deliverable in a single commit;
b) honest: anything you are not sure about goes under an 'Open questions' section.
Avoid planning work that depends on an open question. Commit nothing; leave the file on disk.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    refreshPlanDoc(ISSUE);
    await commitPlan(ISSUE);
  } else {
    log(`Plan doc already exists: ${planDocFor(ISSUE)?.file}`);
  }

  // ---- Phase 2: plan-review ----
  const planAfterWrite = planDocFor(ISSUE);
  if (planAfterWrite === null) {
    log('No plan file; skipping hardening');
  } else {
    await startPhase('plan-review', ISSUE);
    await agent<unknown>(
      'plan-review',
      `${await contextPrefix(ISSUE, "plan-review")}

The plan is at ${planAfterWrite.file}. Review it and revise the file to make it:
a) more detailed: flesh out thin tasks into concrete steps; move anything already answered
   in the issue comments OUT of 'Open questions' and into the detailed plan;
b) more honest: criticise every assumption; move anything with ANY doubt into
   'Open questions', and make sure no planned task depends on an open question.
Queue a comment on #${ISSUE} via 'iteration queue-comment ${ISSUE} "<question>"' for any NEW
open question not already in the injected issue comments. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    await commitPlan(ISSUE);
  }

  const planRef = planDocFor(ISSUE)?.file ?? 'no plan doc exists - work directly from the issue';

  // ---- Phase 3: implement ----
  if (await hasChanges()) {
    log('Dirty worktree; skipping implement phase');
  } else {
    await startPhase('implement', ISSUE);
    await agent<unknown>(
      'implement',
      `${await contextPrefix(ISSUE, "implement")}
The plan is at ${planRef}.

The injected context above already includes the issue's comments (they hold the answers to
open questions) - do only work that is no longer blocked by an open question. Deliver ONE
stable, self-contained
piece of work: either a real deliverable for the ticket, or an intermediary that a later iteration
can build on. Verify it (relevant subset of
npm run lint, npm test, npm run typecheck) before
leaving it in the working tree. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
  }
  commitAndPush(`feat: implement a deliverable for #${ISSUE}`);
  if (await hasCommitsSinceFork(currentBranch)) await ensureDraftPr(ISSUE);

  // ---- Phase 4: critic ----
  await startPhase('critic', ISSUE);
  await agent<unknown>(
    'critic',
    `${await contextPrefix(ISSUE, "critic")}
The plan is at ${planRef}. Aggressively criticise the work delivered on this branch
(git log/diff vs origin/main). Try to break it: run the relevant tests and npm run ci,
look for bugs, edge cases, missed requirements, and plan drift. Then:
- write new tests where breaking potential exists;
- make any fixes or hardening changes that are within your reach;
- update the plan doc (${planRef}) with any new questions raised, under 'Open questions';
- queue a comment on #${ISSUE} via 'iteration queue-comment ${ISSUE} "<question>"' for any open
  question not already in the injected issue comments.
Commit nothing.
Final line MUST be the single JSON object: {}`,
    acceptAnyObject,
    '{}',
  );
  commitAndPush(`test/hardening: critic pass for #${ISSUE}`);
  if (await hasCommitsSinceFork(currentBranch)) await ensureDraftPr(ISSUE);

  // ---- Phase 4.5: address PR review comments ----
  const prNum = await openPrForBranch(repo, currentBranch);
  if (prNum !== null) {
    const pendingForPr = await fetchPendingReviewComments(repo, [prNum]);
    const snapshot = passSnapshot();
    await startPhase('pr-review-rectify', ISSUE, `#${prNum}`);
    await agent<unknown>(
      'pr-review-rectify',
      `${await contextPrefix(ISSUE, "pr-review-rectify")}

An open PR (#${prNum}) targets main for this branch. Its PENDING review comments are read
via GraphQL by the harness and injected below; the PR itself is open on GitHub for detail.
pendingReviewComments=${JSON.stringify(pendingForPr)}
Address every actionable comment: make the requested change, or queue a reply on the issue
via 'iteration queue-comment ${ISSUE} "<reason>"' when it is handled elsewhere (e.g. split
into its own ticket).
Verify with the relevant tests/npm run ci. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    commitAndPush(`fix: address PR review comments for #${prNum}`);
  }

  // ---- PR decision ----
  await prDecisionPhase(ISSUE);
  const finalPr = await openPrForBranch(repo, currentBranch);
  statusFor('pr-decision (done)', ISSUE, finalPr === null ? null : `#${finalPr}`);

  // ---- Consolidated push-back: one comment per issue, once per pass ----
  await flushComments(repo);

  log(`Pass complete for issue #${ISSUE} (${currentBranch})`);
  await checkoutBranch('main');
  return { productive: true, stop: false };
}

async function prDecisionPhase(issue: number): Promise<void> {
  const planFile = planDocFor(issue)?.file;
  await startPhase('pr-decision', issue);
  await agent<LoopDecisionVerdict>(
    'pr-decision',
    `${await contextPrefix(issue, "pr-decision")}
${planFile ? `The plan is at ${planFile}.` : ''}

Decide whether this ticket is meaningfully done: a real deliverable exists, verification
passes, and remaining gaps are honest follow-ups documented in the plan. If yes: run
npm run ci; if it passes, ensure the PR targeting main is not a draft - if it is, run
gh pr ready <number> --repo ${repo.fullName} (open one with gh pr create --repo ${repo.fullName}
--base main --head ${currentBranch} only if none exists) with a short summary linking the
plan file, and close out. If not meaningfully done, do nothing except queue any missing open
questions via 'iteration queue-comment ${issue} "<question>"'.
Final line MUST be the single JSON object: ${LOOP_DECISION_SCHEMA}`,
    validateLoopDecision,
    LOOP_DECISION_SCHEMA,
  );
}
