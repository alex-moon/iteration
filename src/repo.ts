import { execFileSync } from 'node:child_process';
import type { Repo } from './types';
import { fail } from './log';

/** Detects the GitHub repo from the origin remote (ssh or https URL); fails clearly if absent. */
export function detectRepo(): Repo {
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    fail('Cannot detect repo: no origin remote. Run from a GitHub repo with an origin remote.');
  }
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || !m[1] || !m[2]) {
    fail(`Cannot detect a GitHub repo from origin URL: ${url}`);
  }
  return { owner: m[1], name: m[2], fullName: `${m[1]}/${m[2]}` };
}
