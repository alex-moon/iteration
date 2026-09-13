import http from 'node:http';
import type { Repo } from './types';
import { fetchIssues, fetchTicket } from './github';
import { runIteration } from './loop';
import { detectRepo } from './repo';

type TicketCache = Map<string, unknown>;

/** One command served over loopback HTTP so agents can call `iteration get-ticket <n>`. */
export function serve(repo: Repo, cache: TicketCache): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const cmd = url.pathname.slice(1);
      const id = url.searchParams.get('id');

      if (cmd === 'get-ticket' && id) {
        try {
          // Cache misses fall through to a live fetch so agents never see stale absence.
          const payload =
            cache.get(id) ?? fetchTicket(repo, Number(id));
          cache.set(id, payload);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload, null, 2));
          return;
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown command or missing ID: ${cmd}` }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

export async function runOrchestrator(): Promise<void> {
  const cache: TicketCache = new Map();
  let server: http.Server | null = null;
  try {
    // Warm the cache with the open issues and their comment threads so the
    // first get-ticket call in an agent phase is instant.
    const repo: Repo = detectRepo();
    for (const issue of fetchIssues(repo)) {
      cache.set(String(issue.number), issue);
    }
    server = await serve(repo, cache);
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    console.error(`[iteration] orchestrator listening on 127.0.0.1:${port}`);
    // Agent phases resolve `iteration get-ticket <n>` against this loopback port.
    process.env.ITERATION_PORT = String(port);
    runIteration(repo);
  } finally {
    server?.close();
  }
}
