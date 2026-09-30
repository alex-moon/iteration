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
- Claude Code — `claude -p`
- Codex CLI — `codex exec -`
- GitHub Copilot CLI — `copilot -p --no-ask-user -s`

Iteration is bring-your-own-agent: the baselines above are the plain
non-interactive invocation and carry NO approval-bypass flag, so each phase
behaves exactly the way that CLI behaves on its own. In a headless run an
approval prompt has nobody to answer it, so the agent's own rule normally
DENIES the call — that is the agent's documented non-interactive behaviour, not
iteration deciding to deny. Expect to add the agent's own bypass flag (below)
if a phase needs privileged tools.

`iteration --dangerously-approve` opts in by appending each agent's own bypass
flag to the baseline:

| Agent | Appended flag | What it turns off |
| --- | --- | --- |
| opencode | `--auto` | approvals not explicitly denied; explicit `deny` rules still apply |
| Claude Code | `--dangerously-skip-permissions` | prompts AND sandboxing — run isolated |
| Codex CLI | `--dangerously-bypass-approvals-and-sandbox` | approvals AND the sandbox — hardened environment only |
| GitHub Copilot CLI | `--allow-all-tools` | pre-approves every tool — sandbox recommended |

These flags are dangerous by design; use them only in a container/VM. For a
custom command set `ITERATION_AGENT_CMD="<cmd> [args]"` to override the whole
baseline (iteration appends no approval flag to a custom command, so pass one
yourself if you want it); this is also how the mock runner is injected.
`scripts/mock-parity.sh` runs a full mocked `--once` pass in a throwaway clone —
use it instead of ever running a real agent from inside this repo (see
AGENTS.md for why).

Lint gate: `npm run typecheck`.
