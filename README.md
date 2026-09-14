# iteration

Standalone, repo-agnostic iteration-loop orchestrator over GitHub issues.
Run `npx iteration` (after the package is published) or `npm link && iteration`
in any GitHub repo; it starts a loopback HTTP orchestrator plus the pass loop,
and agent phases call back via client commands with `ITERATION_PORT` set:

- `iteration get-ticket <n>` — full ticket (title, body, state, comments)
- `iteration list-issues` — open issues for the pass (with comment threads)
- `iteration submit-verdict <phase> <json>` — deliver a phase verdict mid-phase

Install: `npm install -g .` (or `npm link`) — publishes as `iteration` under
the maintainer's scope when ready (naming to confirm; see open question on
issue #2). `GH_TOKEN` (or an authenticated `gh`) is used for GitHub API reads.

Agent binary: set `ITERATION_AGENT_CMD="<cmd> [args]"` to drive phases with an
alternative/mock agent; defaults to `opencode`. `scripts/mock-parity.sh` runs a
full mocked `--once` pass in a throwaway clone — use it instead of ever running
a real agent from inside this repo (see AGENTS.md for why).

Lint gate: `npm run typecheck`.
