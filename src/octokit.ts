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
    octokit = new Octokit({
      auth: token,
      request: { timeout: 60_000 },
    });
    // Parity evidence: every REST/GraphQL read is logged once, so mock runs can
    // verify the one-list-call-per-pass budget.
    octokit.hook.wrap('request', async (request, options) => {
      log(`gh-api: ${options.method?.toUpperCase() ?? 'GET'} ${options.url}`);
      return request(options);
    });
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

export async function createDraftPr(
  repo: Repo,
  branch: string,
  issue: number,
  issueTitle: string,
  planFile: string | null,
): Promise<number> {
  const body = [
    `Work in progress for #${issue}.`,
    planFile ? `Plan: ${planFile}` : '',
  ].filter(Boolean).join('\n');
  const res = await client().rest.pulls.create({
    owner: repo.owner,
    repo: repo.name,
    base: 'main',
    head: branch,
    draft: true,
    title: `WIP: ${issueTitle} (#${issue})`,
    body,
  });
  log(`Created draft PR #${res.data.number} for ${branch}`);
  return res.data.number;
}

export async function openPrForBranch(repo: Repo, branch: string): Promise<number | null> {
  const res = await client().rest.pulls.list({ owner: repo.owner, repo: repo.name, state: 'open' });
  // GitHub's `head` filter wants `user:branch`; matching on the ref instead
  // stays format-independent and works for fork-head PRs too.
  return res.data.find((p) => p.head.ref === branch)?.number ?? null;
}
