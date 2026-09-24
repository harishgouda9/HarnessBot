#!/usr/bin/env node
/**
 * External MCP control plane: drive the team from Cursor or Claude Desktop.
 *
 * Deliberately bounded. It can inspect, create, organise, send work, wait, interrupt,
 * switch models, and list or respond to approvals. It cannot delete anything, cannot
 * touch credentials, and cannot control computers — an external orchestrator should
 * not be able to do things the user has not seen in the app first.
 */

const PORT_CANDIDATES = [Number(process.env.HB_PORT) || 8799, 18799, 28799];
const TOKEN = process.env.HARNESSBOT_TOKEN;
const EXPLICIT_URL = process.env.HARNESSBOT_URL;
const TIMEOUT_MS = Math.min(120_000, Math.max(1000, Number(process.env.HARNESSBOT_MCP_TIMEOUT_MS) || 30_000));
const ALLOW_INSECURE_HTTP = process.env.ALLOW_INSECURE_HTTP === 'true';

const MAX_MESSAGES = 200;
const MAX_SEARCH_HITS = 100;

if (TOKEN && !EXPLICIT_URL && !process.env.HB_PORT) {
  // A token plus port discovery would mean sending the credential to whatever answers
  // a probe. Require the caller to say where it is going first.
  console.error('HARNESSBOT_TOKEN requires an explicit HARNESSBOT_URL or HB_PORT.');
  process.exit(1);
}

if (EXPLICIT_URL && EXPLICIT_URL.startsWith('http://') && !/127\.0\.0\.1|localhost/.test(EXPLICIT_URL) && !ALLOW_INSECURE_HTTP) {
  console.error('Refusing cleartext HTTP to a remote host. Set ALLOW_INSECURE_HTTP=true if you really mean it.');
  process.exit(1);
}

let baseUrl = EXPLICIT_URL ?? null;

/** Find the harness, and confirm it is actually ours before talking to it. */
async function resolveBase() {
  if (baseUrl) return baseUrl;
  for (const port of PORT_CANDIDATES) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(1500) });
      const json = await res.json();
      if (json?.app === 'harnessbot') {
        baseUrl = candidate;
        return baseUrl;
      }
    } catch {
      // Nothing there, or something that is not us. Keep looking.
    }
  }
  throw new Error('HarnessBot is not running. Start the app, or `pnpm dev:all`.');
}

async function call(method, path, body) {
  const base = await resolveBase();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    // A body is only ever sent with POST/PUT/PATCH; GET requests carry nothing.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
  return text ? JSON.parse(text) : null;
}

/** MCP JSON schemas stay flat: no oneOf / anyOf / allOf / const / format. */
const TOOLS = [
  { name: 'list_bots', description: 'List every bot with its model, section, and activity.', inputSchema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'get_bot',
    description: 'Read one bot, including its tasks and usage.',
    inputSchema: { type: 'object', properties: { botId: { type: 'string' } }, required: ['botId'] },
  },
  {
    name: 'create_bot',
    description: 'Create a bot. Returns its id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        instanceId: { type: 'string', description: 'Engine instance id from list_engines' },
        model: { type: 'string' },
        cwd: { type: 'string' },
        section: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'organize_bot',
    description: 'Move a bot into a section, set its manager, or pin it.',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string' }, section: { type: 'string' }, reportsTo: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['botId'],
    },
  },
  {
    name: 'send_message',
    description: 'Send work to a bot. Returns immediately; use wait_for_reply to block.',
    inputSchema: { type: 'object', properties: { botId: { type: 'string' }, text: { type: 'string' }, newTask: { type: 'boolean' } }, required: ['botId', 'text'] },
  },
  {
    name: 'wait_for_reply',
    description: 'Wait until the bot settles, then return the last reply.',
    inputSchema: { type: 'object', properties: { botId: { type: 'string' }, timeoutSeconds: { type: 'number' } }, required: ['botId'] },
  },
  {
    name: 'read_messages',
    description: `Read a task transcript. At most ${MAX_MESSAGES} messages, and never screenshot pixels.`,
    inputSchema: { type: 'object', properties: { threadId: { type: 'string' }, limit: { type: 'number' } }, required: ['threadId'] },
  },
  {
    name: 'search',
    description: `Search bot names and every transcript. At most ${MAX_SEARCH_HITS} hits.`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  { name: 'interrupt', description: 'Stop a bot mid-turn.', inputSchema: { type: 'object', properties: { botId: { type: 'string' } }, required: ['botId'] } },
  {
    name: 'switch_model',
    description: 'Change a bot model for future turns. History is not rewritten.',
    inputSchema: { type: 'object', properties: { botId: { type: 'string' }, instanceId: { type: 'string' }, model: { type: 'string' } }, required: ['botId', 'model'] },
  },
  { name: 'list_engines', description: 'List engine instances and whether they are available.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'list_pending_approvals', description: 'List approval cards waiting on a human.', inputSchema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'respond_to_approval',
    description: 'Answer one approval card. "always" remembers only the narrow key the server issued for that request.',
    inputSchema: {
      type: 'object',
      properties: { botId: { type: 'string' }, requestId: { type: 'string' }, choiceId: { type: 'string', description: 'allow, deny, always, or a question choice id' }, answer: { type: 'string' } },
      required: ['botId', 'requestId', 'choiceId'],
    },
  },
  {
    name: 'list_rooms',
    description: 'List multi-bot rooms.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'send_to_room',
    description: 'Post into a room. Use @Name to route to a specific member.',
    inputSchema: { type: 'object', properties: { groupId: { type: 'string' }, text: { type: 'string' } }, required: ['groupId', 'text'] },
  },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, args = {}) {
  switch (name) {
    case 'list_bots': {
      const bots = await call('GET', '/api/bots');
      return text(bots.map((b) => ({ id: b.id, name: b.name, title: b.title, section: b.section ?? '', model: b.modelSelection?.model, activity: b.activity, threadId: b.threadId })));
    }
    case 'get_bot': {
      const bots = await call('GET', '/api/bots');
      const bot = bots.find((b) => b.id === args.botId);
      if (!bot) throw new Error('no such bot');
      return text(bot);
    }
    case 'list_engines':
      return text((await call('GET', '/api/instances')).map((i) => ({ instanceId: i.instanceId, state: i.state, reason: i.reason, models: i.models.map((m) => m.id) })));
    case 'create_bot': {
      const engines = await call('GET', '/api/instances');
      const chosen = engines.find((e) => e.instanceId === args.instanceId) ?? engines.find((e) => e.state === 'available');
      if (!chosen) throw new Error('no available engine; run list_engines');
      const bot = await call('POST', '/api/bots', {
        name: args.name,
        title: args.title ?? '',
        description: args.description ?? '',
        cwd: args.cwd,
        section: args.section,
        modelSelection: { instanceId: chosen.instanceId, model: args.model ?? chosen.models.find((m) => m.default)?.id ?? chosen.models[0]?.id },
      });
      return text({ id: bot.id, threadId: bot.threadId });
    }
    case 'organize_bot':
      return text(await call('PATCH', `/api/bots/${args.botId}`, { section: args.section, reportsTo: args.reportsTo, pinned: args.pinned }));
    case 'send_message': {
      if (args.newTask) await call('POST', `/api/bots/${args.botId}/tasks`, { title: args.text.slice(0, 60) });
      return text(await call('POST', `/api/bots/${args.botId}/messages`, { text: args.text }));
    }
    case 'wait_for_reply': {
      const deadline = Date.now() + Math.min(600, Math.max(5, args.timeoutSeconds ?? 120)) * 1000;
      while (Date.now() < deadline) {
        const bots = await call('GET', '/api/bots');
        const bot = bots.find((b) => b.id === args.botId);
        if (!bot) throw new Error('no such bot');
        if (bot.activity === 'waiting-on-you') return text('The bot is waiting on a human approval. Use list_pending_approvals.');
        if (bot.activity === 'idle') {
          const thread = await call('GET', `/api/threads/${bot.threadId}/messages`);
          const last = thread.messages.filter((m) => m.role === 'bot' && m.kind === 'text').at(-1);
          return text(last?.text ?? '(no reply)');
        }
        await sleep(1000);
      }
      return text('Timed out while the bot was still working.');
    }
    case 'read_messages': {
      const thread = await call('GET', `/api/threads/${args.threadId}/messages?limit=${Math.min(MAX_MESSAGES, args.limit ?? MAX_MESSAGES)}`);
      // Screenshot payloads are never worth sending to another model.
      return text(thread.messages.map(({ png: _p, ...m }) => m));
    }
    case 'search': {
      const result = await call('GET', `/api/search?q=${encodeURIComponent(args.query)}`);
      return text({ bots: result.bots, messages: result.messages.slice(0, MAX_SEARCH_HITS) });
    }
    case 'interrupt':
      return text(await call('POST', `/api/bots/${args.botId}/interrupt`, {}));
    case 'switch_model':
      return text(await call('PATCH', `/api/bots/${args.botId}`, { modelSelection: { instanceId: args.instanceId, model: args.model } }));
    case 'list_pending_approvals': {
      const bots = await call('GET', '/api/bots');
      const all = [];
      for (const bot of bots) {
        for (const pending of await call('GET', `/api/bots/${bot.id}/approvals`)) {
          all.push({ botId: bot.id, botName: bot.name, requestId: pending.requestId, tool: pending.toolName, summary: pending.summary, allowKey: pending.allowKey, scope: pending.approvalScope });
        }
      }
      return text(all);
    }
    case 'respond_to_approval':
      return text(await call('POST', `/api/bots/${args.botId}/respond`, { requestId: args.requestId, choiceId: args.choiceId, answer: args.answer }));
    case 'list_rooms':
      return text((await call('GET', '/api/groups')).filter((g) => !g.dm).map((g) => ({ id: g.id, name: g.name, members: g.memberIds, defaultResponder: g.defaultResponder })));
    case 'send_to_room':
      return text(await call('POST', `/api/groups/${args.groupId}/messages`, { text: args.text }));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'harnessbot', version: '0.1.44' } };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return callTool(request.params?.name, request.params?.arguments);
    case 'ping':
      return {};
    default:
      throw new Error(`unsupported method: ${request.method}`);
  }
}

let buffer = '';
/**
 * In-flight requests. stdin closing means "no more requests", not "abandon the ones
 * you are already answering" — a piped client would otherwise lose every reply that
 * needed a round trip to the harness.
 */
let inFlight = 0;
let stdinClosed = false;

const maybeExit = () => {
  if (stdinClosed && inFlight === 0) process.exit(0);
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }

    inFlight++;
    void (async () => {
      try {
        const result = await handle(request);
        if (request.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      } catch (err) {
        if (request.id !== undefined) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(err.message ?? err) } })}\n`);
        }
      } finally {
        inFlight--;
        maybeExit();
      }
    })();
  }
});

process.stdin.on('end', () => {
  stdinClosed = true;
  maybeExit();
});
