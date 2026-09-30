/**
 * Registry of supported coding agents and how to invoke them headlessly.
 *
 * Each agent is driven the same way: the prompt is written to the child's
 * stdin and the phase transcript is read from stdout. The args below are the
 * non-interactive invocation ONLY - they do NOT suppress approval prompts.
 * Iteration is "bring your own agent": it inherits whatever permission posture
 * each CLI ships with, so a phase behaves exactly as that CLI would on its own.
 * In a headless run a would-be approval prompt has nobody to answer it, so the
 * CLI's own rule usually denies the call (this is not iteration deciding to
 * deny - it is the agent's documented non-interactive behaviour).
 *
 * `approveFlag` is the agent's own documented bypass flag. It is appended
 * ONLY when the operator opts in with `iteration --dangerously-approve`; the
 * baselines above never carry it. See README.md for the per-agent risk notes.
 */
export interface Agent {
  id: string;
  label: string;
  command: string[];
  approveFlag: string[];
  hint: string;
  risk: string;
}

export const AGENTS: Agent[] = [
  {
    id: 'opencode',
    label: 'opencode',
    command: ['opencode', 'run'],
    approveFlag: ['--auto'],
    hint: 'reads a piped stdin message in non-interactive mode',
    risk: '--auto approves anything not explicitly denied; explicit deny rules still apply',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: ['claude', '-p'],
    approveFlag: ['--dangerously-skip-permissions'],
    hint: 'print mode; reads the prompt from stdin',
    risk: '--dangerously-skip-permissions skips prompts AND sandboxing; run only in an isolated container/VM',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: ['codex', 'exec', '-'],
    approveFlag: ['--dangerously-bypass-approvals-and-sandbox'],
    hint: 'exec reads the prompt from stdin via the "-" sentinel',
    risk: '--dangerously-bypass-approvals-and-sandbox removes approvals AND the sandbox; use only in an externally hardened environment',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: ['copilot', '-p', '--no-ask-user', '-s'],
    approveFlag: ['--allow-all-tools'],
    hint: 'programmatic mode; -s keeps stdout to the response',
    risk: '--allow-all-tools pre-approves every tool; GitHub advises against it outside a sandbox',
  },
];

export const DEFAULT_AGENT_ID = 'opencode';

/** The provider's own bypass flag, or [] when the agent has none. */
export function approveFlagFor(id: string): string[] {
  return agentById(id)?.approveFlag ?? [];
}

export function agentById(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id;
}
