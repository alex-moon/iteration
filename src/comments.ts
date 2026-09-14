import type { Repo } from './types';
import { client } from './octokit';
import { log } from './log';

/**
 * Phases no longer push to GitHub directly: they queue messages via
 * `iteration queue-comment <n> '<body>'` and the orchestrator posts one
 * consolidated comment per issue at the end of the pass.
 */
interface QueuedComment {
  issue: number;
  by: string;
  body: string;
}

const queue: QueuedComment[] = [];

export function queueComment(issue: number, body: string, by: string): void {
  if (body.trim() === '') return;
  queue.push({ issue, by, body: body.trim() });
}

export function pendingComments(): QueuedComment[] {
  return [...queue];
}

/**
 * Pushes the pass's queued messages to GitHub as one comment per issue:
 * identical bodies collapse; each distinct agent entry is attributed.
 */
export async function flushComments(repo: Repo): Promise<void> {
  if (queue.length === 0) return;
  const dryRun = process.env.ITERATION_DRY_RUN === '1';
  const perIssue = new Map<number, QueuedComment[]>();
  for (const item of queue.splice(0)) {
    const list = perIssue.get(item.issue) ?? [];
    list.push(item);
    perIssue.set(item.issue, list);
  }
  for (const [issue, items] of perIssue) {
    const seen = new Set<string>();
    const entries = items.filter((i) => {
      if (seen.has(i.body)) return false;
      seen.add(i.body);
      return true;
    });
    const body = `Consolidated pass feedback (${entries.length} note${
      entries.length === 1 ? '' : 's'
    }):\n\n${entries.map((e) => `- **${e.by}**: ${e.body}`).join('\n\n')}`;
    try {
      if (dryRun) {
        log(`dry-run: would post consolidated comment on #${issue} (${entries.length} notes)`);
        continue;
      }
      await client().rest.issues.createComment({
        owner: repo.owner,
        repo: repo.name,
        issue_number: issue,
        body,
      });
      log(`posted consolidated comment on #${issue} (${entries.length} notes)`);
    } catch (err) {
      log(`consolidated comment on #${issue} failed: ${(err as Error).message}`);
    }
  }
}
