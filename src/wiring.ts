import type { Repo } from './types';

/**
 * Shared prompt frame for orchestrator-provided state: agents get state via
 * client commands (ITERATION_PORT is set by the orchestrator), never by
 * re-running gh list calls.
 */
export function stateCommandsBlock(phase: string, issue: number | null, repo: Repo): string {
  const issueNote =
    issue === null ? '' : `\n- iteration get-ticket ${issue} fetches this ticket's full detail`;
  return `TICKET STATE comes from the running orchestrator (ITERATION_PORT is set):
- iteration get-ticket <n> fetches one ticket: title, body, state, comments;
- iteration list-issues lists the open issues with their comment threads${issueNote};
- iteration submit-verdict ${phase} '<json>' submits your final verdict mid-phase (asked once per prompt).
Do not re-run gh issue list / gh pr list for this repo (${repo.fullName});
individual gh calls for anything else remain available.`;
}
