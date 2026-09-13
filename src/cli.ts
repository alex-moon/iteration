import http from 'node:http';
import { fail } from './log';

// ============================================================================
// MODE 1: CLIENT. An agent phase ran `iteration get-ticket <n>` with the
// orchestrator's loopback port inherited via ITERATION_PORT.
// ============================================================================
function runClientCommand(cmd: string, arg: string, port: number): void {
  const req = http.get(
    `http://127.0.0.1:${port}/${cmd}?id=${encodeURIComponent(arg || '')}`,
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        console.log(data);
        process.exit(res.statusCode === 200 ? 0 : 1);
      });
    },
  );
  req.on('error', (err) => {
    fail(`iteration client request error: ${err.message}`);
  });
}

// ============================================================================
// MODE 2: ORCHESTRATOR. The user (or a wrapper) ran `npx iteration` in a repo.
// ============================================================================
function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const arg = argv[1] ?? '';
  const port = process.env.ITERATION_PORT;

  if (command && port) {
    runClientCommand(command, arg, Number(port));
    return;
  }

  if (command && command !== 'start') {
    fail(
      `Unknown command: ${command}. Run 'iteration' (or 'iteration start') to start the orchestrator,` +
        ' or set ITERATION_PORT in an agent phase to use client commands.',
    );
  }

  void import('./orchestrator').then((m) => m.runOrchestrator());
}

main();
