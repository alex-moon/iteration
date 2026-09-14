import { execFileSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import { log } from './log';
import type { Repo } from './types';

let octokit: Octokit | null = null;

/**
 * Octokit instance shared by every GitHub read in the harness. Auth prefers
 * GH_TOKEN; the single `gh auth token` child call keeps `gh`-authenticated
 * environments working with zero setup.
 */
export function client(): Octokit {
  if (octokit === null) {
    const token = process.env.GH_TOKEN ?? readGhToken();
    octokit = new Octokit(token === undefined ? {} : { auth: token });
  }
  return octokit;
}

function readGhToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function openPrForBranch(repo: Repo, branch: string): Promise<number | null> {
  const res = await client().rest.pulls.list({ owner: repo.owner, repo: repo.name, head: `${repo.fullName}:${branch}`, state: 'open' });
  return res.data[0]?.number ?? null;
}
