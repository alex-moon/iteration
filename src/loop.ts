import type { LoopDecisionVerdict, Repo } from './types';
import { LOOP_DECISION_SCHEMA } from './types';
import { checkoutBranch } from './git-client';
import { log, fail } from './log';
import { PASS_INTERVAL, getPriority, initCli, isOnce } from './config';
import { validateLoopDecision } from './verdicts';
import { agent } from './agent';
import { loadLoopState, writeLoopState, clearShutdown } from './loop-state';
import { stateCommandsBlock } from './wiring';
import { repoInfo, runPass, setRepo, type PassOutcome } from './pass';
import { CancelledError, checkpointEx } from './control';
import { setStatus } from './status';
import { sleepUntilActivity } from './activity';

function nowIso(): string {
  return new Date().toISOString();
}

// ---- Loop-decision agent -----------------------------------------------------------------

export async function decideLoop(): Promise<boolean> {
  const v = await agent<LoopDecisionVerdict>(
    'loop-decision',
    `You have just completed an iteration pass on the GitHub open
 issues of the repo. Recent activity is visible in .git/iteration/logs/iteration-*.log, plan docs
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

// ---- Dormancy ---------------------------------------------------------------------------

/** Sleeps until the state leaves shutdown mode (new activity). No-op under --once. */
async function dormant(repo: Repo): Promise<void> {
  if (isOnce()) return;
  const state = loadLoopState();
  setStatus({ phase: 'sleep', mode: 'dormant', repo: repo.fullName });
  log(`Shutdown in effect (${state?.reason ?? ''}); sleeping until new GitHub activity (poll every ${PASS_INTERVAL}s)`);
  await sleepUntilActivity(repo);
  log('Loop woken from dormancy: restarting full iteration');
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
    if (state !== null && state.mode === 'decision' && state.decidedAt !== null) {
      if (isOnce()) return;
      await dormant(repo);
      continue;
    }

    let outcome: PassOutcome;
    try {
      checkpointEx();
      outcome = await runPass();
    } catch (err) {
      if (err instanceof CancelledError) {
        log('Cancel requested between phases; stopping cleanly');
        await checkoutBranch('main');
        return;
      }
      log(`Pass failed hard: ${(err as Error).message}`);
      process.exitCode = 1;
      await checkoutBranch("main");
      if (loadLoopState()?.mode === 'decision') {
        writeLoopState(0, 'strikes', nowIso(), (err as Error).message);
      }
      return;
    }

    if (outcome.stop) {
      // Triage strikes exhausted: enter dormant sleep mode instead of exiting.
      // The first sleep poll records the activity baseline; any later change
      // wakes the loop deterministically.
      writeLoopState(0, 'decision', nowIso(), 'Triage found no workable issues for consecutive passes');
      continue;
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
        await dormant(repo);
        continue;
      }
    }
    if (isOnce()) return;
  }
}
