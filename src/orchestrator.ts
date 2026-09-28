import http from 'node:http';
import type { IssueInfo, PassSnapshot, Repo } from './types';
import { fetchIssues, fetchTicket } from './github';
import { log } from './log';
import { recordSubmittedVerdict } from './submit-state';
import { queueComment } from './comments';
import { passSnapshot } from './snapshot';
import { detectRepoFromOrigin } from './git-client';
import { runIteration } from './loop';
import { resolveAgent } from './agent';
import { clearPid, pidAlive, readPid, writePid } from './pid';
import { readStatus, setStatus, touchStatus } from './status';
import { statusAgeSeconds } from './status';

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

        if (cmd === 'queue-comment') {
          const raw = await readPostBody(req);
          try {
            const parsed = JSON.parse(raw) as { issue: number; by: string; body: string };
            if (!Number.isInteger(parsed.issue) || typeof parsed.body !== 'string') {
              respond(400, { error: 'expected body {"issue":<number>,"body":"<comment>"}' });
              return;
            }
            queueComment(parsed.issue, parsed.body, typeof parsed.by === 'string' ? parsed.by : 'agent');
            respond(200, { ok: true });
          } catch {
            respond(400, { error: 'unparsable body; expected {"issue":<number>,"body":"<comment>"}' });
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

const HEARTBEAT_SECS = 60;

function onSignal(sig: string): void {
  log(`received ${sig}; stopping cleanly`);
  try {
    const s = readStatus();
    const ticket = s?.ticket;
    setStatus({
      phase: `stopped (was: ${s?.phase ?? 'unknown'})`,
      mode: 'stopped',
      repo: s?.repo ?? null,
      number: ticket?.number ?? null,
      title: ticket?.title ?? null,
      branch: ticket?.branch ?? null,
      pr: ticket?.pr ?? null,
    });
  } catch {
    // status is best-effort on the way out
  }
  clearPid();
  process.exit(sig === 'SIGINT' ? 130 : 143);
}

/**
 * Hardens the loop against the failure mode seen in the field (2026-09-17,
 * alex-moon/tova): the harness process was killed a second after starting the
 * implement phase, so status.json kept claiming 'running', the phase
 * transcript was lost, and the detached phase agent talked to a dead port.
 * - SIGHUP is ignored: a closing parent terminal/session terminates a
 *   non-detached child silently, which is exactly that death.
 * - SIGINT/SIGTERM write an honest 'stopped' status and release the pid.
 * - A heartbeat keeps status.json updatedAt fresh so 'dead harness' is
 *   observable; a stale 'running' status with a dead pid is reported loudly.
 * - pid.json lets a new run detect a live sibling instance.
 */
export async function runOrchestrator(): Promise<void> {
  let server: http.Server | null = null;
  try {
    const repo = await detectRepoFromOrigin();
    // Resolve the agent up front: an interactive first run shows the picker
    // here, starting the harness proper only after a choice is cached.
    resolveAgent();
    const previousPid = readPid();
    const siblingLive = previousPid !== null && pidAlive(previousPid);
    if (siblingLive) {
      log(`warning: pid.json points at a live process (${previousPid}); another harness may already be running on ${repo.fullName}`);
    }
    const staleStatus = readStatus();
    if (staleStatus !== null && staleStatus.mode === 'running' && !siblingLive) {
      log(
        `previous run died mid-phase without a clean stop: status.json says '${staleStatus.phase}' (mode running, updated ${staleStatus.updatedAt}, age ${statusAgeSeconds(staleStatus)}s) but pid is gone; not recovering automatically - review the last log in .git/iteration/logs/ and restart`,
      );
    }
    writePid();
    process.on('SIGHUP', () => {
      log('ignoring SIGHUP (parent session closed); continuing');
    });
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    const heartbeat = setInterval(() => touchStatus(), HEARTBEAT_SECS * 1000);
    heartbeat.unref();
    server = await serve(repo);
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    console.error(`[iteration] orchestrator listening on 127.0.0.1:${port}`);
    // Agent phases resolve client commands against this loopback port.
    process.env.ITERATION_PORT = String(port);
    await runIteration(repo);
  } finally {
    clearPid();
    // A run that exits by returning (end of pass, cancelled, failed) must not
    // leave status claiming 'running'; only a sudden death should.
    const finalStatus = readStatus();
    if (finalStatus !== null && finalStatus.mode === 'running') {
      const ticket = finalStatus.ticket;
      setStatus({
        phase: `stopped (was: ${finalStatus.phase})`,
        mode: 'stopped',
        repo: finalStatus.repo,
        number: ticket.number,
        title: ticket.title,
        branch: ticket.branch,
        pr: ticket.pr,
      });
    }
    server?.close();
  }
}
