# AGENTS.md

Guidance for any agent (opencode, Claude, human via CLI) working in this repo.

## CRITICAL: Never spawn a real agent from this repo

This repo IS an iteration orchestrator that spawns agent phases via a coding
CLI (opencode, Claude Code, Codex CLI, or GitHub Copilot CLI — see `src/agents.ts`).
Running this repo's code (or testing it naively) will spawn a NEW agent, which
will then try to work on this repo and spawn another agent, recursively.

Rules:

- Do NOT run any of the supported agent CLIs from this repo, and do NOT run the
  orchestrator with a real agent binary inside an agent session.
- To exercise pass/loop logic while developing, set `ITERATION_AGENT_CMD` to a mock
  runner (a script that prints canned JSON verdicts matching the phase schema).
  See `src/agent.ts` — the runner is injectable so tests and mock runs never
  spawn a real agent. `scripts/mock-parity.sh` is the ready-made full-pass mock
  run (throwaway clone, no pushes).
- Prefer unit-style tests and the orchestrator HTTP-server round-trips over
  running the full loop.

## Repo purpose

Standalone, repo-agnostic iteration-loop orchestrator over GitHub issues.
`npx iteration` starts the orchestrator (loopback HTTP server + loop);
agents inside phases call `iteration get-ticket <n>` etc. with `ITERATION_PORT` set.

## Commands

- `npm run typecheck` — the de-facto lint gate; keep it clean (there is no eslint config).
- `node bin/iteration.js` — same as `npx iteration` after `npm link`.
- Client commands (agent phases): `iteration get-ticket <n>`, `iteration list-issues`,
  `iteration submit-verdict <json>` (needs `ITERATION_PORT` from a running orchestrator).

## Conventions

- TypeScript in `src/`, one concern per module; no comments unless asked for a reason.
- Repo detection is from `git remote get-url origin`; nothing is hardcoded per-repo.
- Branch naming `feat/<issue>-<slug>`; plan docs `.iteration/docs/plan-<issue>-<summary>.md`;
  logs and harness state in `.git/iteration/` (kept out of the worktree so it can never
  produce dirty files that block branch checkouts).
- Agent-facing prompts must prefer orchestrator commands (`get-ticket`,
  `list-issues`, `submit-verdict`) over the agents re-running `gh` list calls;
  one set of list calls per pass is the harness's job.
