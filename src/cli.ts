import http from 'node:http';
import { fail } from './log';

const CLIENT_COMMANDS = ['get-ticket', 'list-issues', 'submit-verdict', 'queue-comment'];

function runClientCommand(command: string, args: string[], port: number): void {
  const phase = args[0] ?? '';

  let method = 'GET';
  let path: string;
  let body: string | undefined;
  if (command === 'submit-verdict') {
    const verdict = args[1];
    if (verdict === undefined || verdict === '') {
      fail('submit-verdict needs: iteration submit-verdict <phase-title> <json>');
    }
    method = 'POST';
    body = JSON.stringify({ phase, verdict });
    path = '/submit-verdict';
  } else if (command === 'queue-comment') {
    const issue = Number(phase);
    const comment = args[1];
    if (!Number.isInteger(issue) || issue <= 0 || comment === undefined || comment === '') {
      fail('queue-comment needs: iteration queue-comment <issue-number> "<comment text>"');
    }
    method = 'POST';
    body = JSON.stringify({ issue, by: process.env.ITERATION_PHASE || 'agent', body: comment });
    path = '/queue-comment';
  } else {
    path = `/${command}?id=${encodeURIComponent(phase)}`;
  }

  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method,
      path,
      headers: { 'Content-Length': Buffer.byteLength(body ?? '') },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        console.log(data);
        process.exit(res.statusCode === 200 ? 0 : 1);
      });
    },
  );
  req.on('error', (err) => fail(`iteration client request error: ${err.message}`));
  req.end(body);
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? '';
  const args = argv.slice(1);
  const port = process.env.ITERATION_PORT;

  if (port && CLIENT_COMMANDS.includes(command)) {
    runClientCommand(command, args, Number(port));
    return;
  }

  if (port) {
    fail(
      `Unknown client command: ${command}. Known: ${CLIENT_COMMANDS.join(', ')}` +
        ' (requires ITERATION_PORT from a running orchestrator).',
    );
  }

  if (command === 'tui') {
    require('./tui').runTui();
    return;
  }

  if (command !== '' && command !== 'start' && command !== '--once' && !/^\d+$/.test(command)) {
    fail(
      `Unknown command: ${command}. Run 'iteration' (or 'iteration start') to start the orchestrator,` +
      ' run `iteration tui` for the control center,' +
      ' or set ITERATION_PORT in an agent phase to use client commands.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./orchestrator').runOrchestrator();
}

main();
