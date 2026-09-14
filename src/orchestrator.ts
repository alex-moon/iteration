import http from 'node:http';
import type { IssueInfo, PassSnapshot, Repo } from './types';
import { fetchIssues, fetchTicket } from './github';
import { log } from './log';
import { recordSubmittedVerdict } from './submit-state';
import { passSnapshot } from './snapshot';
import { detectRepoFromOrigin } from './git-client';
import { runIteration } from './loop';

export type TicketCache = Map<string, unknown>;

function readPostBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const cache: TicketCache = new Map();

/** Refresh the cache with the open issues incl. comment threads; called exactly once per pass. */
export async function warmTicketCache(repo: Repo): Promise<IssueInfo[]> {
  try {
    const issues = await fetchIssues(repo);
    cache.delete('open-issues');
    cache.set('open-issues', { issues });
    for (const issue of issues) {
      cache.set(String(issue.number), issue);
    }
    log(`ticket cache refreshed: ${issues.length} open issues`);
    return issues;
  } catch (err) {
    log(`ticket-cache refresh failed: ${(err as Error).message}`);
    return [];
  }
}

export function cachedIssues(): unknown[] {
  const entry = cache.get('open-issues') as { issues: unknown[] } | undefined;
  return entry?.issues ?? [];
}

export function serve(repo: Repo): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const respond = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload, null, 2));
      };
      const run = async (): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const cmd = url.pathname.slice(1);
        const id = url.searchParams.get('id') ?? '';

        if (cmd === 'get-ticket') {
          if (!/^\d+$/.test(id)) {
            respond(400, { error: `get-ticket needs a numeric id, got: ${id}` });
            return;
          }
          try {
            // Cache is refreshed once per pass; misses fall through to a live fetch,
            // so agents never see stale absence.
            const payload = cache.get(id) ?? fetchTicket(repo, Number(id));
            cache.set(id, payload);
            respond(200, payload);
          } catch (err) {
            respond(500, { error: (err as Error).message });
          }
          return;
        }

        if (cmd === 'list-issues') {
          const snapshot: PassSnapshot | null = passSnapshot();
          if (snapshot === null) {
            respond(503, { error: 'no pass snapshot gathered yet; try again shortly' });
            return;
          }
          respond(200, { gatheredAt: snapshot.gatheredAt, issues: snapshot.issues });
          return;
        }

        if (cmd === 'submit-verdict') {
          const raw = await readPostBody(req);
          try {
            const parsed = JSON.parse(raw) as { phase: string; verdict: string };
            if (typeof parsed.phase !== 'string' || typeof parsed.verdict !== 'string') {
              respond(400, { error: 'expected body {"phase":"<title>","verdict":"<json-string>"}' });
              return;
            }
            recordSubmittedVerdict(parsed.phase, parsed.verdict);
            respond(200, { ok: true });
          } catch {
            respond(400, { error: 'unparsable body; expected {"phase":"<title>","verdict":"<json-string>"}' });
          }
          return;
        }

        respond(404, { error: `Unknown command: ${cmd}` });
      };
      void run().catch((err) => respond(500, { error: (err as Error).message }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export { cache as orchestratorCache };

export async function runOrchestrator(): Promise<void> {
  let server: http.Server | null = null;
  try {
    const repo = await detectRepoFromOrigin();
    server = await serve(repo);
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    console.error(`[iteration] orchestrator listening on 127.0.0.1:${port}`);
    // Agent phases resolve client commands against this loopback port.
    process.env.ITERATION_PORT = String(port);
    await runIteration(repo);
  } finally {
    server?.close();
  }
}
