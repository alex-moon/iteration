import type { Repo } from './types';

/**
 * Shared client-commands frame. Context is INJECTED into the prompt by the
 * orchestrator (frozen per-pass snapshot); agents never re-run gh list calls
 * and never post comments directly. The block covers only the two write paths:
 * submitting the final verdict and queueing a comment for consolidation.
 */
export function stateCommandsBlock(phase: string, issue: number | null, repo: Repo): string {
  const issueNote =
    issue === null ? '' : `\n- iteration get-ticket ${issue} re-fetches one ticket's detail (fallback; everything relevant is already injected above)`;
  return `WRITE-BACK commands (ITERATION_PORT is set by the running orchestrator):
- iteration submit-verdict ${phase} '<json>' submits your final verdict mid-phase (asked once per prompt);
- iteration queue-comment <issue-number> '<comment text>' queues a comment; the orchestrator
  consolidates everything queued during the pass and posts one comment per issue to
  ${repo.fullName} at the end of the pass - so do NOT run 'gh issue comment' or 'gh pr comment'.${issueNote}
NEVER run gh issue list / gh pr list for this repo; never post to GitHub directly.`;
}
