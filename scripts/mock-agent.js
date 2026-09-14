#!/usr/bin/env node
/* eslint-disable */
const fs = require('fs');
const http = require('http');

const phase = process.env.ITERATION_PHASE || 'unknown';
const stateFile = process.env.MOCK_STATE_FILE || '/tmp/opencode/mock-agent-state.json';

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { counts: {} };
  }
}
function saveState(s) {
  fs.mkdirSync(require('path').dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(s));
}

const state = loadState();
state.counts[phase] = (state.counts[phase] || 0) + 1;
const n = state.counts[phase];
saveState(state);
state.prompts = state.prompts || [];
state.prompts.push({ phase, at: new Date().toISOString(), prompt: String(process.argv[2] || '') });
saveState(state);

function out(text) {
  process.stdout.write(text);
  process.exit(0);
}

function submitVerdict(phase, verdict) {
  const port = process.env.ITERATION_PORT;
  if (!port) return Promise.resolve({ ok: false });
  const body = JSON.stringify({ phase, verdict });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/submit-verdict',
        headers: { 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode }));
      },
    );
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.end(body);
  });
}

(async () => {
  if (phase === 'triage-tickets' && n === 1) {
    out('I think issue 2 is a good starting point, going with that.');
  }
  if (phase === 'triage-tickets') {
    out('{"kind":"issue","issue":2}');
  }
  if (phase === 'implement') {
    const posted = await submitVerdict('implement', '{"ok":true}');
    if (posted.ok) out('');
    out('{"via":"fallback"}');
  }
  if (phase === 'loop-decision') out('{"decision":"END","reason":"mock parity run: nothing actionable left"}');
  if (phase === 'pr-decision') out('{"decision":"CONTINUE"}');
  out('{"note":"mock"}');
})();
