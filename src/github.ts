import type { IssueComment, IssueInfo, PendingReviewFeedback, PrInfo, Repo } from './types';
import { client } from './octokit';
import { log } from './log';

const ISSUE_LIST_FIELDS = 'number,title,updatedAt';

export async function fetchIssues(repo: Repo): Promise<IssueInfo[]> {
  const { data: list } = await client().rest.issues.listForRepo({
    owner: repo.owner,
    repo: repo.name,
    state: 'open',
    per_page: 50,
  });
  const issues = list.filter((i) => !('pull_request' in i));
  return Promise.all(
    issues.map(async (i) => {
      let comments: IssueComment[] = [];
      try {
        const { data } = await client().rest.issues.listComments({
          owner: repo.owner,
          repo: repo.name,
          issue_number: i.number,
          per_page: 50,
        });
        comments = data.map((c) => ({
          by: c.user?.login ?? 'unknown',
          at: c.created_at,
          body: c.body ?? '',
        }));
      } catch (err) {
        log(`comments for #${i.number} fetch failed: ${(err as Error).message}`);
      }
      return { number: i.number, title: i.title ?? '', updatedAt: i.updated_at, comments };
    }),
  );
}

export async function fetchOpenPrs(repo: Repo): Promise<PrInfo[]> {
  try {
    const { data } = await client().rest.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: 'open',
    });
    return data.map((p) => ({
      number: p.number,
      title: p.title ?? '',
      headRefName: p.head.ref,
      updatedAt: p.updated_at,
    }));
  } catch (err) {
    log(`open-pr list failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * PENDING reviews are invisible to the REST comment endpoints; read them via
 * the GraphQL reviews API instead.
 */
export async function fetchPendingReviewComments(
  repo: Repo,
  prNumbers: number[],
): Promise<PendingReviewFeedback[]> {
  const results: PendingReviewFeedback[] = [];
  for (const pr of prNumbers) {
    const query =
      '{ repository(owner: "' +
      repo.owner +
      '", name: "' +
      repo.name +
      '") { pullRequest(number: ' +
      pr +
      ') { reviews(states: PENDING, first: 10) { nodes { author { login } comments(first: 50) { nodes { body path line } } } } } } }';
    try {
      const parsed = (await client().graphql(query)) as {
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
      const nodes = parsed.repository?.pullRequest?.reviews?.nodes ?? [];
      const reviews = nodes.map((n) => ({
        author: n.author?.login ?? 'unknown',
        comments: (n.comments?.nodes ?? []).map((c) => ({ ...c })),
      }));
      if (reviews.some((r) => r.comments.length > 0)) {
        results.push({ pr, reviews });
      }
    } catch {
      log(`pending-review GraphQL read failed for PR #${pr}`);
    }
  }
  return results;
}

export async function fetchIssueTitle(repo: Repo, issue: number): Promise<string> {
  try {
    const { data } = await client().rest.issues.get({
      owner: repo.owner,
      repo: repo.name,
      issue_number: issue,
    });
    return data.title ?? '';
  } catch (err) {
    log(`title fetch for #${issue} failed: ${(err as Error).message}`);
    return '';
  }
}

/** Full single-ticket payload served to agents by `iteration get-ticket <n>`. */
export async function fetchTicket(repo: Repo, issue: number): Promise<unknown> {
  const { data } = await client().rest.issues.get({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issue,
  });
  const { data: comments } = await client().rest.issues.listComments({
    owner: repo.owner,
    repo: repo.name,
    issue_number: issue,
    per_page: 50,
  });
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    updatedAt: data.updated_at,
    body: data.body ?? '',
    comments: comments.map((c) => ({
      by: c.user?.login ?? 'unknown',
      at: c.created_at,
      body: c.body ?? '',
    })),
  };
}
