# Plan: Generalize the harness into the standalone iteration orchestrator (#2)

## Motivation

Issue #2, checklist in the issue: wire phases to orchestrator commands, prove
degraded-run parity, keep the ticket cache fresh, make `npx iteration` usable,
audit agent-side `gh` calls, migrate shell-out to Octokit/simple-git, and purge
old references. Refs #1 (closed).

## Decisions so far

- The loopback HTTP server **cannot** serve agent phases while `runIteration`
  blocks the event loop in `execFileSync` — so agent phases become async
  (promisified child processes) before any wiring can work mid-phase.
- The agent runner becomes injectable via `ITERATION_AGENT_CMD` so mock runs
  (and this repo's recursive-agent hazard) never accidentally spawn `opencode`.
- An `AGENTS.md` now documents the no-recursion rule mock-first testing.

## Checklist

- [ ] Async agent phases (promisified `execFile`, verdict path unchanged).
- [ ] Orchestrator serves `list-issues` and `submit-verdict` alongside
      `get-ticket`.
- [ ] Ticket cache refreshed once per pass (freshness decision), documented.
- [ ] Phase prompts drop the inline PASS SNAPSHOT; agents use orchestrator
      commands, snapshot text kept only as a fallback when no port is set.
- [ ] Audit agent-side gh calls; read-style calls routed, write-once calls
      documented as intentional `gh` use.
- [ ] `gh`/`git` child-process calls replaced by Octokit + simple-git.
- [ ] Mocked end-to-end parity run: one pass, one set of gh list calls,
      verdict-retry-once demonstrated, loop-state semantics preserved.
