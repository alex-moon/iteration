/**
 * Registry of supported coding agents and how to invoke them headlessly.
 *
 * Each agent is driven the same way: the prompt is written to the child's
 * stdin and the phase transcript is read from stdout. The args below are the
 * non-interactive invocation PLUS the flags that suppress approval prompts,
 * because the harness runs unattended - a CLI that stops to ask for approval
 * with nobody to answer it would wedge the phase (the idle-timeout then kills
 * it). They were verified against current CLI docs; see README.md.
 */
export interface Agent {
  id: string;
  label: string;
  command: string[];
  hint: string;
}

export const AGENTS: Agent[] = [
  {
    id: 'opencode',
    label: 'opencode',
    command: ['opencode', 'run'],
    hint: 'reads a piped stdin message in non-interactive mode',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    command: ['claude', '-p', '--dangerously-skip-permissions'],
    hint: 'print mode; bypasses permission prompts for unattended runs',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    command: ['codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-'],
    hint: 'exec reads the prompt from stdin via the "-" sentinel',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    command: ['copilot', '-p', '--allow-all-tools', '--no-ask-user', '-s'],
    hint: 'programmatic mode; pre-approves tools and never asks the user',
  },
];

export const DEFAULT_AGENT_ID = 'opencode';

export function agentById(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}

export function agentLabel(id: string): string {
  return agentById(id)?.label ?? id;
}
