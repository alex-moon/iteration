# iteration

Standalone, repo-agnostic iteration-loop orchestrator over GitHub issues.
Run `npx iteration` (after the package is published) or `npm link && iteration`
in any GitHub repo; it starts a loopback HTTP orchestrator plus the pass loop,
and agent phases call back via client commands with `ITERATION_PORT` set:

- `iteration get-ticket <n>` — full ticket (title, body, state, comments; fallback)
- `iteration list-issues` — open issues for the pass (with comment threads)
- `iteration submit-verdict <phase> <json>` — deliver a phase verdict mid-phase
- `iteration queue-comment <n> '<body>'` — queue a comment; the orchestrator
  posts one consolidated comment per issue to GitHub at the end of the pass

Context is injected into each phase prompt from a frozen per-pass snapshot
(triage sees every ticket, dedicated phases only theirs), so agents should not
need `gh`. Plans live in `.iteration/docs/`; logs and harness state live in `.git/iteration/`.

Install: `npm install -g @alex-moon/iteration` (or `npm link`) — the public
scope is `@alex-moon/iteration`; the binary remains `iteration`.
`GH_TOKEN` (or an authenticated `gh`) is used for GitHub API reads.

Agent binary: on first run iteration asks which coding agent should drive the
phases and caches the choice per user (`~/.config/iteration/config.json`, or
`$XDG_CONFIG_HOME`/`%APPDATA%`; override with `ITERATION_CONFIG_DIR` /
`ITERATION_CONFIG_FILE`). Supported agents:

- `opencode` — `opencode run`
- Claude Code — `claude -p --dangerously-skip-permissions`
- Codex CLI — `codex exec --dangerously-bypass-approvals-and-sandbox -`
- GitHub Copilot CLI — `copilot -p --allow-all-tools --no-ask-user -s`

The approval-bypass flags are what let the harness run unattended: a CLI that
stops to ask with nobody to answer would hang the phase. Set
`ITERATION_AGENT_CMD="<cmd> [args]"` to override the whole command (this is also
how the mock runner is injected). `scripts/mock-parity.sh` runs a full mocked
`--once` pass in a throwaway clone — use it instead of ever running a real agent
from inside this repo (see AGENTS.md for why).

Lint gate: `npm run typecheck`.
