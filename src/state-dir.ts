import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let cached: string | null = null;

/**
 * Harness-internal state (logs, status.json, loop-state.json, control.json)
 * lives in <repoRoot>/.git/iteration/ so it can never produce dirty files in
 * the worktree it drives (checkout cannot conflict with state it never sees).
 */
export function stateDir(): string {
  if (cached === null) {
    let root = process.cwd();
    try {
      const out = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
      if (out !== '') root = out;
    } catch {
      // not inside a git repo; fall back to cwd
    }
    cached = path.join(root, '.git', 'iteration');
    fs.mkdirSync(cached, { recursive: true });
  }
  return cached;
}
