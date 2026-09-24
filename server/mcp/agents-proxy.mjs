#!/usr/bin/env node
/**
 * The `agents` MCP mount: how a bot talks to its peers.
 *
 * It is a thin proxy, on purpose. Recursion limits, permissions, and the mirrored DM
 * all stay on the harness, so a bot cannot widen its own reach by talking to this
 * process differently (HB-PRD-001 F-ROOM-06).
 */

const TOKEN = process.env.HB_INTERNAL_TOKEN;
const BOT_ID = process.env.HB_INTERNAL_BOT;
const BASE = process.env.HB_INTERNAL_URL ?? 'http://127.0.0.1:8799';

const TOOLS = [
  {
    name: 'list_bots',
    description: 'List the other agents you can ask or delegate to. Use only names from this list.',
    // Flat schema only: no oneOf / anyOf / allOf / const / format.
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ask_bot',
    description: 'Ask another agent and wait for their reply. Use this when you need the answer before you continue. The exchange is mirrored into a DM the user can read.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the agent to ask' },
        text: { type: 'string', description: 'What to ask' },
      },
      required: ['name', 'text'],
    },
  },
  {
    name: 'delegate_bot',
    description: 'Hand a task to another agent. They work it on their own chat. This returns as soon as the task is handed off — it does not include their finished answer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['name', 'text'],
    },
  },
  {
    name: 'remember',
    description: 'Save a durable fact about this workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', description: 'fact, preference, correction, entity, decision, task_outcome, or reference' },
      },
      required: ['text'],
    },
  },
];

async function callHarness(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${res.status}`);
  return text ? JSON.parse(text) : null;
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'harnessbot-agents', version: '0.1.44' },
      };
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = request.params ?? {};
      if (name === 'list_bots') {
        const bots = await callHarness('/api/internal/list-bots');
        return { content: [{ type: 'text', text: JSON.stringify(bots) }] };
      }
      if (name === 'ask_bot') {
        const result = await callHarness('/api/internal/ask-bot', { name: args.name, text: args.text, kind: 'ask' });
        const text = result.reply || result.error || 'No reply.';
        return { content: [{ type: 'text', text }] };
      }
      if (name === 'delegate_bot') {
        const result = await callHarness('/api/internal/ask-bot', { name: args.name, text: args.text, kind: 'delegate' });
        const text = result.ok
          ? `${result.peerName} is working on it in their own chat.`
          : result.error || 'Could not delegate.';
        return { content: [{ type: 'text', text }] };
      }
      if (name === 'remember') {
        await callHarness('/api/internal/memory', { scope: 'bot', botId: BOT_ID, text: args.text, kind: args.kind ?? 'fact', source: 'bot_inferred' });
        return { content: [{ type: 'text', text: 'Saved. The user can see and edit it in the memory panel.' }] };
      }
      throw new Error(`unknown tool: ${name}`);
    }
    default:
      throw new Error(`unsupported method: ${request.method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void (async () => {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const result = await handle(request);
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
      } catch (err) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String(err.message ?? err) } })}\n`,
        );
      }
    })();
  }
});
