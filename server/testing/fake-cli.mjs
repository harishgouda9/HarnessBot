#!/usr/bin/env node
/**
 * Scripted fake provider CLI.
 *
 * Driver contract tests spawn this instead of mocking child_process, so they exercise
 * the real spawn path, the real line splitting, and the real stdin round-trip
 * (HB-TRD-001 s4.3). Behaviour is chosen with FAKE_MODE.
 */

import fs from 'node:fs';

const mode = process.env.FAKE_MODE ?? 'text';
const say = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

if (process.argv.includes('--version')) {
  process.stdout.write('fake-cli 1.0.0\n');
  process.exit(0);
}

const promptFileAt = process.argv.indexOf('--prompt-file');
const promptFromFile = promptFileAt >= 0 ? fs.readFileSync(process.argv[promptFileAt + 1], 'utf8') : '';

let prompt = promptFromFile;
process.stdin.setEncoding('utf8');

const lines = [];
process.stdin.on('data', (chunk) => {
  lines.push(chunk);
  const joined = lines.join('');
  // The first line is the prompt; later lines are permission answers.
  const parts = joined.split('\n');
  if (!prompt && parts.length > 0) prompt = parts[0];
  for (const line of parts.slice(1)) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'permission_response') onAnswer(msg);
    } catch {
      /* partial line */
    }
  }
});

process.stdin.on('end', () => {
  if (!started) start();
});

if (promptFromFile) {
  // File-prompt CLIs (Grok Build) never send a prompt on stdin.
  queueMicrotask(() => {
    if (!started) start();
  });
}

let started = false;
let pendingRequestId = null;

function onAnswer(msg) {
  if (msg.id !== pendingRequestId) return;
  pendingRequestId = null;
  if (msg.approved) {
    say({ type: 'tool_result', id: 'call_1', name: 'Bash', title: 'hello', ok: true });
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Command ran.' }] } });
  } else {
    say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Understood, I will not run it.' }] } });
  }
  finish();
}

/**
 * Keep the event loop alive while waiting on stdin. Without this the process exits
 * as soon as the prompt is consumed, and the harness (correctly) resolves the open
 * card as unavailable — which is right in production but useless in a test.
 */
let holdTimer = null;
function hold() {
  process.stdin.resume();
  holdTimer = setInterval(() => {}, 1000);
}

function finish(isError = false) {
  if (holdTimer) clearInterval(holdTimer);
  say({
    type: 'result',
    is_error: isError,
    usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 3, total_cost_usd: 0.0004 },
  });
  process.exit(isError ? 1 : 0);
}

function start() {
  started = true;

  say({ type: 'system', session_id: process.env.FAKE_SESSION_ID ?? 'sess_fake_1' });

  switch (mode) {
    case 'missing-cli':
      process.stderr.write('command not found\n');
      process.exit(127);
      break;

    case 'auth-fail':
      process.stderr.write('401 Unauthorized: please sign in\n');
      process.exit(1);
      break;

    case 'usage-dump':
      // argparse on a bad flag: the whole subcommand list, `login` among them. It is
      // a broken invocation, not an auth failure.
      process.stderr.write('usage: fake [-h] {chat,setup,login,logout,auth,status}\n');
      process.stderr.write('fake: error: argument command: invalid choice\n');
      process.exit(2);
      break;

    case 'exit-early':
      // Dies mid-turn with no result line: the driver must still settle the turn.
      process.exit(3);
      break;

    case 'crash':
      say({ type: 'error', message: 'upstream exploded' });
      finish(true);
      break;

    case 'tool':
      say({ type: 'tool', id: 'call_1', name: 'Read', title: 'README.md' });
      say({ type: 'tool_result', id: 'call_1', name: 'Read', ok: true });
      say({ type: 'assistant', message: { content: [{ type: 'text', text: 'I read the file.' }] } });
      finish();
      break;

    case 'permission':
      pendingRequestId = 'req_1';
      say({ type: 'permission', id: 'req_1', tool: 'Bash', command: 'git status', summary: 'git status' });
      // Deliberately does not exit: it waits for the answer on stdin.
      hold();
      break;

    case 'question':
      pendingRequestId = 'req_q';
      say({ type: 'question', id: 'req_q', question: 'Which branch?', choices: ['main', 'develop'] });
      hold();
      break;

    case 'stream':
      for (const piece of ['Hel', 'lo ', 'from ', 'the ', 'fake ', 'CLI.']) {
        say({ type: 'text', delta: piece });
      }
      say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello from the fake CLI.' }] } });
      finish();
      break;

    case 'slow':
      // Long-running: the interrupt test kills this.
      setInterval(() => say({ type: 'text', delta: '.' }), 50);
      break;

    default:
      say({ type: 'assistant', message: { content: [{ type: 'text', text: `pong: ${prompt.trim()}` }] } });
      finish();
  }
}

// Not every launch closes stdin promptly; start on the next tick regardless.
setTimeout(() => {
  if (!started) start();
}, 30);
