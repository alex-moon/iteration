import type { LoopDecisionVerdict, Repo, TriageVerdict } from './types';
import { LOOP_DECISION_SCHEMA, TRIAGE_SCHEMA } from './types';
import { git } from './shell';
import { log } from './log';
import { STRIKE_LIMIT, getPriority } from './config';
import { acceptAnyObject, validateLoopDecision, validateTriage } from './verdicts';
import { agent } from './agent';
import { addStrike } from './loop-state';
import {
  currentSnapshot,
  gatherSnapshot,
  planDocFor,
  refreshPlanDoc,
  setGatheredSnapshot,
  snapshotBlock,
} from './snapshot';
import { fetchIssueTitle, fetchPendingReviewComments, openPrForBranch } from './github';

let currentBranch = 'main';
let repo: Repo;

export function setRepo(r: Repo): void {
  repo = r;
}

export function repoInfo(): Repo {
  return repo;
}

// ---- Git helpers ---------------------------------------------------------------------

function hasChanges(): boolean {
  return git(['status', '--porcelain']).trim() !== '';
}

function repoRoot(): string {
  return git(['rev-parse', '--show-toplevel']).trim();
}

function commitAndPush(msg: string): void {
  if (hasChanges()) {
    git(['add', '-A']);
    git(['commit', '-m', msg]);
    git(['push', '-u', 'origin', currentBranch, '--quiet']);
    log(`Committed and pushed: ${msg}`);
  } else {
    log(`Nothing to commit for: ${msg}`);
  }
}

function commitPlan(issue: number): void {
  const status = git(['status', '--porcelain', '--', 'docs']);
  if (status.trim() === '') {
    log('No plan changes to commit');
    return;
  }
  git(['add', 'docs']);
  git(['commit', '-m', `docs: plan updates for #${issue}`]);
  git(['push', '-u', 'origin', currentBranch, '--quiet']);
  log('Committed and pushed plan updates');
  refreshPlanDoc(issue);
}

// ---- Shared prompt frame ---------------------------------------------------------------

function contextPrefix(issue: number): string {
  return `You are working in the repo ${repoRoot()} on branch ${currentBranch} for GitHub issue #${issue}
in ${repo.fullName}. The PASS SNAPSHOT below already holds the open issues with their comments, the
open PRs (including PENDING review comments read via GraphQL) and the plan docs; individual
gh calls for anything else remain available. Read docs/overview.md and docs/workflow.md for
background if present. Follow the repo's existing conventions. Do NOT commit or push - the
orchestrator does that. Before doing anything, confirm from the repo's own state (not just
issue comments) that this ticket is neither already done nor blocked on the user: if it is,
post the blocking reason as a gh issue comment on #${issue} and stop immediately without
doing any work.
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
next one to work on. Do NOT trust issue state alone: judge each ticket from the repo itself.
The PASS SNAPSHOT has the open issues with their full comment conversations, the open PRs
(with PENDING review comments where present) and the plan docs per issue - you do NOT need
to re-run gh issue list / gh pr list; only post issue comments or fetch detail that is
genuinely missing.${priorityNote}
1. Classify each issue as exactly one of:
   - DONE:   the deliverable exists and is verified (green PR/checks or work landed on main);
             a branch whose name contains the ticket number carrying the deliverable with an
             open PR against main means the ticket is in review or done.
   - BLOCKED: progress requires something only the user can provide - an unanswered open
             question, an access request, or a decision the repo gives no basis to make.
   - READY:  work is possible now that could move the ticket forward.
   If an issue is BLOCKED and has no comment already stating that, post
   'gh issue comment <n> --repo ${repo.fullName}' briefly stating why and what would unblock
   it (once per ticket; if an identical comment already exists, do not re-post).
2. If every open issue is DONE or BLOCKED, your final line is {"kind":"none"}.
3. Otherwise pick ONE issue: prefer tickets whose comments contain answers to previously
   raised open questions, then smaller well-scoped READY issues over sprawling ones.
   Never pick a DONE ticket, and never pick a BLOCKED ticket.
4. Final line MUST be the single JSON object: ${TRIAGE_SCHEMA}`;
}

export function triagePhase(): TriageVerdict {
  const v = agent<TriageVerdict>(
    'triage-tickets',
    `${triagePrompt()}

${snapshotBlock(null)}`,
    validateTriage,
    TRIAGE_SCHEMA,
  );
  const snapshot = currentSnapshot();
  if (v.kind === 'issue' && snapshot !== null && !snapshot.issues.some((i) => i.number === v.issue)) {
    throw new Error(`triage returned issue ${v.issue} which is not in the current snapshot`);
  }
  return v;
}

// ---- Branch helpers ------------------------------------------------------------------------

export function ensureBranch(issue: number): string {
  const branches = git(['branch', '-a', '--format=%(refname:short)'])
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean);
  // Match on the issue number so the convention stays repo-agnostic.
  const match = branches.find((b) => b.includes(`/${issue}-`));
  if (match) {
    const branch = match.replace(/^origin\//, '');
    git(['checkout', branch]);
    const pulled = git(['pull', 'origin', branch, '--quiet']);
    if (pulled === '' && git(['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== branch) {
      log('pull failed; continuing with local state');
    }
    return branch;
  }
  const title = fetchIssueTitle(repo, issue);
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 2)
    .join('-');
  const summary = words === '' ? 'iteration' : words;
  const branch = `feat/${issue}-${summary}`;
  git(['checkout', '-b', branch, 'origin/main']);
  log(`Created branch ${branch}`);
  return branch;
}

// ---- Pass body -------------------------------------------------------------------------------

export interface PassOutcome {
  productive: boolean;
  stop: boolean;
}

export function runPass(): PassOutcome {
  setGatheredSnapshot(gatherSnapshot(repo));

  // ---- Phase 0: triage ----
  const pick = triagePhase();
  if (pick.kind === 'none') {
    log('Triage verdict: none');
    if (!addStrike('strikes', 'triage returned ISSUE:NONE')) {
      log(
        `All work blocked for ${STRIKE_LIMIT} consecutive strikes; downing tools pending final grace check`,
      );
      return { productive: false, stop: true };
    }
    return { productive: false, stop: false };
  }
  const ISSUE = pick.issue;
  log(`Triage verdict: ISSUE:${ISSUE}`);

  // ---- Branch ----
  currentBranch = ensureBranch(ISSUE);
  refreshPlanDoc(ISSUE);
  log(`Working branch: ${currentBranch}`);

  // ---- Phase 1: plan-write ----
  const plan = planDocFor(ISSUE);
  if (plan === null) {
    agent<unknown>(
      'plan-write',
      `${contextPrefix(ISSUE)}

Write a plan at docs/plan-${ISSUE}-<summary>.md (summary matches the branch name suffix). It
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
    commitPlan(ISSUE);
  } else {
    log(`Plan doc already exists: ${planDocFor(ISSUE)?.file}`);
  }

  // ---- Phase 2: plan-review ----
  const planAfterWrite = planDocFor(ISSUE);
  if (planAfterWrite === null) {
    log('No plan file; skipping hardening');
  } else {
    agent<unknown>(
      'plan-review',
      `${contextPrefix(ISSUE)}

The plan is at ${planAfterWrite.file}. Review it and revise the file to make it:
a) more detailed: flesh out thin tasks into concrete steps; move anything already answered
   in the issue comments OUT of 'Open questions' and into the detailed plan;
b) more honest: criticise every assumption; move anything with ANY doubt into
   'Open questions', and make sure no planned task depends on an open question.
Post a gh issue comment on #${ISSUE} for any NEW open question not already in the issue
comments. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    commitPlan(ISSUE);
  }

  const planRef = planDocFor(ISSUE)?.file ?? 'no plan doc exists - work directly from the issue';

  // ---- Phase 3: implement ----
  if (hasChanges()) {
    log('Dirty worktree; skipping implement phase');
  } else {
    agent<unknown>(
      'implement',
      `${contextPrefix(ISSUE)}
The plan is at ${planRef}.

Read the issue comments in the PASS SNAPSHOT first for answers to open questions - do only
work that is no longer blocked by an open question. Deliver ONE stable, self-contained piece
of work: either a real deliverable for the ticket, or an intermediary that a later iteration
can build on. Verify it (relevant subset of npm run lint, npm test, npm run typecheck) before
leaving it in the working tree. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
  }
  commitAndPush(`feat: implement a deliverable for #${ISSUE}`);

  // ---- Phase 4: critic ----
  agent<unknown>(
    'critic',
    `${contextPrefix(ISSUE)}
The plan is at ${planRef}. Aggressively criticise the work delivered on this branch
(git log/diff vs origin/main). Try to break it: run the relevant tests and npm run ci,
look for bugs, edge cases, missed requirements, and plan drift. Then:
- write new tests where breaking potential exists;
- make any fixes or hardening changes that are within your reach;
- update the plan doc (${planRef}) with any new questions raised, under 'Open questions';
- post a gh issue comment on #${ISSUE} for any open question not already in the issue comments.
Commit nothing.
Final line MUST be the single JSON object: {}`,
    acceptAnyObject,
    '{}',
  );
  commitAndPush(`test/hardening: critic pass for #${ISSUE}`);

  // ---- Phase 4.5: address PR review comments ----
  const prNum = openPrForBranch(repo, currentBranch);
  if (prNum !== null) {
    // Refresh pending-review data for this specific PR (reviews may have
    // arrived since the snapshot at the top of the pass).
    const snapshot = currentSnapshot();
    if (snapshot !== null) {
      snapshot.pendingReviewComments = fetchPendingReviewComments(repo, [prNum]).concat(
        snapshot.pendingReviewComments.filter((p) => p.pr !== prNum),
      );
    }
    agent<unknown>(
      'pr-review-rectify',
      `${contextPrefix(ISSUE)}

An open PR (#${prNum}) targets main for this branch. Read its review comments and rectify
them in the working tree:
- the PR and its reviews, including PENDING review comments, are in the PASS SNAPSHOT;
- address every actionable comment: make the requested change, or reply/post on the issue
  why it is handled elsewhere (e.g. split into its own ticket).
Verify with the relevant tests/npm run ci. Commit nothing.
Final line MUST be the single JSON object: {}`,
      acceptAnyObject,
      '{}',
    );
    commitAndPush(`fix: address PR review comments for #${prNum}`);
  }

  // ---- PR decision ----
  prDecisionPhase(ISSUE);

  log(`Pass complete for issue #${ISSUE} (${currentBranch})`);
  git(['checkout', 'main']);
  return { productive: true, stop: false };
}

function prDecisionPhase(issue: number): void {
  const planFile = planDocFor(issue)?.file;
  agent<LoopDecisionVerdict>(
    'pr-decision',
    `${contextPrefix(issue)}
${planFile ? `The plan is at ${planFile}.` : ''}

Decide whether this ticket is meaningfully done: a real deliverable exists, verification
passes, and remaining gaps are honest follow-ups documented in the plan. If yes: run
npm run ci; if it passes, open a PR targeting main (gh pr create --repo ${repo.fullName}
--base main --head ${currentBranch}) with a short summary linking the plan file, and close
out. If not meaningfully done, do nothing except post any missing open questions as a gh
issue comment on #${issue}.
Final line MUST be the single JSON object: ${LOOP_DECISION_SCHEMA}`,
    validateLoopDecision,
    LOOP_DECISION_SCHEMA,
  );
}
