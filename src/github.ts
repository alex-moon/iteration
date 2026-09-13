import type { IssueComment, IssueInfo, PendingReviewFeedback, PrInfo, Repo } from './types';
import { gh, ghAllowFail } from './shell';
import { log } from './log';

export function fetchIssues(repo: Repo): IssueInfo[] {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo.fullName,
    '--state',
    'open',
    '--limit',
    '50',
    '--json',
    'number,title,updatedAt',
  ]);
  const list = JSON.parse(raw) as { number: number; title: string; updatedAt: string }[];
  return list.map((i) => {
    const commentsRaw = ghAllowFail(
      ['api', `repos/${repo.fullName}/issues/${i.number}/comments?per_page=50`],
      `comment fetch for #${i.number}`,
    );
    let comments: IssueComment[] = [];
    if (commentsRaw.trim() !== '') {
      try {
        comments = (
          JSON.parse(commentsRaw) as {
            body: string;
            user: { login: string };
            created_at: string;
          }[]
        ).map((c) => ({ by: c.user.login, at: c.created_at, body: c.body }));
      } catch {
        log(`comments for #${i.number} unparsable; treating as none`);
      }
    }
    return { number: i.number, title: i.title, updatedAt: i.updatedAt, comments };
  });
}

export function fetchOpenPrs(repo: Repo): PrInfo[] {
  const raw = ghAllowFail(
    [
      'pr',
      'list',
      '--repo',
      repo.fullName,
      '--state',
      'open',
      '--json',
      'number,title,headRefName,updatedAt',
    ],
    'pr list',
  );
  if (raw.trim() === '') return [];
  try {
    return JSON.parse(raw) as PrInfo[];
  } catch {
    log('gh pr list returned unparsable JSON');
    return [];
  }
}

/**
 * PENDING reviews are invisible to the REST comment endpoints; read them via
 * the GraphQL reviews API instead.
 */
export function fetchPendingReviewComments(repo: Repo, prNumbers: number[]): PendingReviewFeedback[] {
  return prNumbers.flatMap((pr) => {
    const query =
      '{ repository(owner: "' +
      repo.owner +
      '", name: "' +
      repo.name +
      '") { pullRequest(number: ' +
      pr +
      ') { reviews(states: PENDING, first: 10) { nodes { author { login } comments(first: 50) { nodes { body path line } } } } } } }';
    const raw = ghAllowFail(['api', 'graphql', '-f', `query=${query}`], `pending reviews for PR #${pr}`);
    if (raw.trim() === '') return [];
    try {
      const parsed = JSON.parse(raw) as {
        data?: {
          repository?: {
            pullRequest?: {
              reviews?: {
                nodes?: {
                  author?: { login?: string };
                  comments?: { nodes?: { body: string; path: string; line: number | null }[] };
                }[];
              };
            };
          };
        };
      };
      const nodes = parsed.data?.repository?.pullRequest?.reviews?.nodes ?? [];
      const reviews = nodes.map((n) => ({
        author: n.author?.login ?? 'unknown',
        comments: (n.comments?.nodes ?? []).map((c) => ({ ...c })),
      }));
      if (reviews.every((r) => r.comments.length === 0)) return [];
      return [{ pr, reviews }];
    } catch {
      log(`pending-review GraphQL read failed for PR #${pr}`);
      return [];
    }
  });
}

export function fetchIssueTitle(repo: Repo, issue: number): string {
  const raw = ghAllowFail(
    ['issue', 'view', String(issue), '--repo', repo.fullName, '--json', 'title'],
    `issue view for #${issue}`,
  );
  try {
    return (JSON.parse(raw) as { title: string }).title ?? '';
  } catch {
    return '';
  }
}

export function openPrForBranch(repo: Repo, branch: string): number | null {
  const raw = ghAllowFail(
    ['pr', 'list', '--repo', repo.fullName, '--head', branch, '--state', 'open', '--json', 'number'],
    'pr list for branch',
  );
  if (raw.trim() === '') return null;
  try {
    const arr = JSON.parse(raw) as { number: number }[];
    return arr[0]?.number ?? null;
  } catch {
    return null;
  }
}

/** Full single-ticket payload served to agents by `iteration get-ticket <n>`. */
export function fetchTicket(repo: Repo, issue: number): unknown {
  const raw = gh(
    [
      'issue',
      'view',
      String(issue),
      '--repo',
      repo.fullName,
      '--json',
      'number,title,state,body,updatedAt,comments',
    ],
  );
  const parsed = JSON.parse(raw) as {
    number: number;
    title: string;
    state: string;
    body: string;
    updatedAt: string;
    comments: { author?: { login?: string }; createdAt?: string; body?: string }[];
  };
  return {
    number: parsed.number,
    title: parsed.title,
    state: parsed.state,
    updatedAt: parsed.updatedAt,
    body: parsed.body,
    comments: parsed.comments.map((c) => ({
      by: c.author?.login ?? 'unknown',
      at: c.createdAt ?? '',
      body: c.body ?? '',
    })),
  };
}
