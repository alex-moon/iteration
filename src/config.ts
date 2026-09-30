// CLI/env configuration, shared by the orchestrator and the loop.

let ONCE = false;
let PRIORITY: number | undefined;
let DANGEROUSLY_APPROVE = false;

export function setOnce(v: boolean): void {
  ONCE = v;
}

export function isOnce(): boolean {
  return ONCE;
}

/**
 * Whether the operator opted into the agent's own approval-bypass flag. This
 * defaults to false so a phase inherits the agent's normal permission posture;
 * only `iteration --dangerously-approve` flips it.
 */
export function setDangerouslyApprove(v: boolean): void {
  DANGEROUSLY_APPROVE = v;
}

export function isDangerouslyApprove(): boolean {
  return DANGEROUSLY_APPROVE;
}

export function setPriority(n: number | undefined): void {
  PRIORITY = n;
}

export function getPriority(): number | undefined {
  return PRIORITY;
}

export const STRIKE_LIMIT = Number(process.env.STRIKE_LIMIT ?? '3') || 3;
export const PASS_INTERVAL = Number(process.env.PASS_INTERVAL ?? '900') || 900;

const CLI_FLAGS = ['--once', '--dangerously-approve'];

/** Parses `[--once] [--dangerously-approve] [priority-issue-number]`. */
export function initCli(argv: string[]): void {
  setOnce(argv.includes('--once'));
  setDangerouslyApprove(argv.includes('--dangerously-approve'));
  const priorityArgs = argv.filter((a) => !CLI_FLAGS.includes(a));
  if (priorityArgs.length > 1) {
    throw new Error('Too many arguments: pass at most one issue number');
  }
  const raw = priorityArgs[0];
  const p = raw === undefined ? undefined : Number(raw);
  if (p !== undefined && (!Number.isInteger(p) || p <= 0)) {
    throw new Error(`Priority must be an issue number, got: ${String(raw)}`);
  }
  setPriority(p);
}
