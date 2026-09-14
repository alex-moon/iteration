import type { CheckVerdict, LoopDecisionVerdict, Repo } from './types';
import { CHECK_SCHEMA, LOOP_DECISION_SCHEMA } from './types';
import { sleepSeconds } from './shell';
import { checkoutBranch } from './git-client';
import { log, fail } from './log';
import { PASS_INTERVAL, STRIKE_LIMIT, getPriority, initCli, isOnce } from './config';
import { validateCheck, validateLoopDecision } from './verdicts';
import { agent } from './agent';
import { addStrike, clearShutdown, loadLoopState, writeLoopState } from './loop-state';
import { stateCommandsBlock } from './wiring';
import { gatherSnapshot, setGatheredSnapshot, snapshotText } from './snapshot';
import { repoInfo, runPass, setRepo, type PassOutcome } from './pass';
import { warmTicketCache } from './orchestrator';

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Loop-decision agent -----------------------------------------------------------------

export async function decideLoop(): Promise<boolean> {
  const v = await agent<LoopDecisionVerdict>(
    'loop-decision',
    `You have just completed an iteration pass on the GitHub open
issues of the repo. Recent activity is visible in .iteration/logs/iteration-*.log, plan docs
in .iteration/docs/,
open PRs and issue comments in GitHub. Decide whether the iteration loop should CONTINUE or END.

END the loop when: all open issues are meaningfully done or blocked, and what remains needs
only the user (answers to open questions, access, decisions) with nothing actionable left.
Otherwise CONTINUE.

${stateCommandsBlock('loop-decision', null, repoInfo())}
Final line MUST be the single JSON object: ${LOOP_DECISION_SCHEMA}`,
    validateLoopDecision,
    LOOP_DECISION_SCHEMA,
  );
  if (v.decision === 'END') {
    const reason = v.reason ?? 'no reason given';
    log(`loop-decision recorded shutdown: ${reason}`);
    writeLoopState(0, 'decision', nowIso(), reason);
    return false;
  }
  log('loop-decision: continue');
  return true;
}

// ---- Limited shutdown check -----------------------------------------------------------------

/**
 * Returns 0: resume full work; 2: strike, skip work phases but keep looping;
 * 1: strikes exhausted, down tools. `countStrike=false` performs a strike-free
 * check (used for the final grace check before actually stopping).
 */
export async function checkShutdown(countStrike = true): Promise<0 | 2 | 1> {
  const state = loadLoopState();
  if (state === null || state.mode !== 'decision' || state.decidedAt === null) return 0;
  const priority = getPriority();
  const priorityNote =
    priority !== undefined
      ? `
Note: the user has marked issue #${priority} as PRIORITY - also check
whether it specifically now shows new information.`
      : '';
  // The snapshot is per-pass and this check runs between passes: refresh it so
  // the injected snapshot reflects "now" before looking for new information.
  try {
    const warmedIssues = await warmTicketCache(repoInfo());
    setGatheredSnapshot(await gatherSnapshot(repoInfo(), warmedIssues));
  } catch (err) {
    log(`shutdown-check snapshot refresh failed: ${(err as Error).message}`);
  }
  const v = await agent<CheckVerdict>(
    'loop-check',
    `A previous iteration of this loop has already decided that all GitHub
issues of this repo are either meaningfully done or blocked.
Decision recorded at: ${state.decidedAt}
Reason: ${state.reason ?? ''}${priorityNote}

Perform a LIMITED check only - do not re-run full triage, do not do any work.
Look ONLY for new information in GitHub issues since ${state.decidedAt} that could change
that decision:
- new issue comments that ANSWER a previously blocking open question, add new
  requirements, or otherwise make meaningful work possible again;
- new open issues or new open PRs.
CONTEXT INJECTION (frozen snapshot, refreshed at the start of this check - you do NOT need
to re-run gh issue list / pr list):
${snapshotText()}

${stateCommandsBlock('loop-check', null, repoInfo())}
Final line MUST be the single JSON object: ${CHECK_SCHEMA}`,
    validateCheck,
    CHECK_SCHEMA,
  );
  if (v.verdict === 'NEW') {
    clearShutdown();
    return 0;
  }
  log(`No new information in GitHub issues since ${state.decidedAt}`);
  if (!countStrike) {
    log('Final grace check confirmed: nothing new; downing tools');
    return 1;
  }
  if (addStrike('decision', `limited shutdown check found no new information since ${state.decidedAt}`)) {
    return 2;
  }
  log(`Decision exhausted ${STRIKE_LIMIT} strikes; one final grace check in ${PASS_INTERVAL}s`);
  return 1;
}

/**
 * Final grace period before downing tools: wait one more interval, run one
 * strike-free shutdown check, and resume the loop if new information arrived.
 * Returns true only when the loop should keep going.
 */
async function graceResume(): Promise<boolean> {
  if (isOnce()) return false;
  sleepSeconds(PASS_INTERVAL);
  return (await checkShutdown(false)) === 0;
}

// ---- Main loop -------------------------------------------------------------------------------

export async function runIteration(repo: Repo): Promise<void> {
  setRepo(repo);
  try {
    initCli(process.argv.slice(2));
  } catch (err) {
    fail((err as Error).message);
  }
  log(
    `Starting iteration harness on ${repo.fullName} (priority: ${
      getPriority() === undefined ? 'none' : `#${getPriority()}`
    }, once: ${isOnce()})`,
  );
  while (true) {
    const state = loadLoopState();
    let stale = false;
    if (state !== null && state.mode === 'decision' && state.decidedAt !== null) {
      const outcome = await checkShutdown();
      if (outcome === 1) {
        if (await graceResume()) continue;
        log('Loop ended after shutdown decision exhausted its strikes');
        return;
      }
      if (outcome === 2) stale = true;
    }
    if (stale) {
      if (isOnce()) return;
      log(`Shutdown in effect; next limited check in ${PASS_INTERVAL}s`);
      sleepSeconds(PASS_INTERVAL);
      continue;
    }

    let outcome: PassOutcome;
    try {
      outcome = await runPass();
    } catch (err) {
      log(`Pass failed hard: ${(err as Error).message}`);
      process.exitCode = 1;
      await checkoutBranch("main");
      if (loadLoopState()?.mode === 'decision') {
        writeLoopState(0, 'strikes', nowIso(), (err as Error).message);
      }
      return;
    }

    if (outcome.stop) {
      // Strikes exhausted via triage ISSUE:NONE; final grace check, then stop.
      if (await graceResume()) continue;
      log('Loop ended: all work blocked and strikes exhausted');
      return;
    }

    if (outcome.productive) {
      let doContinue = false;
      try {
        doContinue = await decideLoop();
      } catch (err) {
        log(`loop-decision failed hard: ${(err as Error).message}`);
        writeLoopState(0, 'strikes', nowIso(), `loop-decision failed: ${(err as Error).message}`);
      }
      if (!doContinue) {
        stale = true;
      }
    }
    if (stale && loadLoopState()?.mode === 'decision') {
      if (isOnce()) return;
      log(`Shutdown in effect; next limited check in ${PASS_INTERVAL}s`);
      sleepSeconds(PASS_INTERVAL);
      continue;
    }
    if (isOnce()) return;
    log(`Next pass in ${PASS_INTERVAL}s`);
    sleepSeconds(PASS_INTERVAL);
  }
}
