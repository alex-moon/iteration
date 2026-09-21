import simpleGit, { type SimpleGit } from 'simple-git';
import { fail, log } from './log';
import type { Repo } from './types';

/**
 * Every git operation in the repo goes through this simple-git instance
 * (Octokit handles GitHub API reads separately in github.ts).
 */

function gitClient(): SimpleGit {
  return simpleGit({ timeout: { block: 10 * 60_000 } });
}

export async function hasChanges(): Promise<boolean> {
  return (await gitClient().status(['--porcelain'])).isClean() === false;
}

export async function hasPathChanges(path: string): Promise<boolean> {
  const status = await gitClient().status(['--porcelain', '--', path]);
  return status.files.length > 0;
}

export async function repoRoot(): Promise<string> {
  return (await gitClient().raw(['rev-parse', '--show-toplevel'])).trim();
}

export async function addAllAndCommit(msg: string): Promise<void> {
  await gitClient().add(['-A']);
  await gitClient().commit(msg);
}

export async function addPathAndCommit(path: string, msg: string): Promise<void> {
  await gitClient().add([path]);
  await gitClient().commit(msg);
}

export async function pushBranch(branch: string): Promise<void> {
  await gitClient().push(['-u', 'origin', branch, '--quiet']);
}

/**
 * Clears leftover tracked-file modifications (staged or unstaged). The
 * harness keeps state in .git/iteration/ and commits deliverables at each
 * phase boundary, so anything dirty at a branch boundary is debris from an
 * interrupted pass, not work to preserve. Untracked files are left alone.
 */
export async function discardLocalChanges(): Promise<void> {
  const g = gitClient();
  await g.reset(['--mixed', '--quiet']);
  await g.checkout(['--', '.']);
}

export async function checkoutBranch(branch: string, newFrom?: string): Promise<void> {
  if (newFrom !== undefined) await gitClient().checkout(['-b', branch, newFrom]);
  else await gitClient().checkout(branch);
}

/**
 * Return to main, clearing leftover worktree dirt if that is what blocks us.
 * Uses throwaway-safe discard so a dirty pass boundary never fails the whole
 * pass or the loop.
 */
export async function safeCheckoutMain(): Promise<void> {
  try {
    await checkoutBranch('main');
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0] ?? '';
    const wt = /already used by worktree at '(.+?)'/.exec(msg)?.[1];
    if (wt) {
      log(`checkout main blocked by worktree at ${wt}; removing it and retrying`);
      await gitClient().raw(['worktree', 'remove', '--force', wt]);
      await checkoutBranch('main');
      return;
    }
    log(`checkout main failed (${msg}); clearing local changes and retrying`);
    await discardLocalChanges();
    await checkoutBranch('main');
  }
}

export async function pullBranch(branch: string): Promise<boolean> {
  try {
    await gitClient().pull('origin', branch, ['--quiet']);
    return true;
  } catch {
    return false;
  }
}

export async function listBranches(): Promise<string[]> {
  // simple-git's .branch() parser cannot handle a custom --format (returns .all = []),
  // so read the raw output directly.
  const out = await gitClient().raw(['branch', '-a', '--format=%(refname:short)']);
  return out.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

export async function currentBranch(): Promise<string> {
  return (await gitClient().raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

export async function hasCommitsSinceFork(branch: string): Promise<boolean> {
  const count = await gitClient().raw(['rev-list', '--count', `origin/main..${branch}`]);
  return parseInt(count.trim(), 10) > 0;
}

/** Detects the GitHub repo from the origin remote (ssh or https URL); fails clearly if absent. */
export async function detectRepoFromOrigin(): Promise<Repo> {
  let url = '';
  try {
    url = (await gitClient().raw(['remote', 'get-url', 'origin'])).trim();
  } catch {
    fail('Cannot detect repo: no origin remote. Run from a GitHub repo with an origin remote.');
  }
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || !m[1] || !m[2]) {
    fail(`Cannot detect a GitHub repo from origin URL: ${url}`);
  }
  return { owner: m[1]!, name: m[2]!, fullName: `${m[1]}/${m[2]}` };
}
