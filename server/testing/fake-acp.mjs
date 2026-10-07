#!/usr/bin/env node
/**
 * Scripted fake ACP agent.
 *
 * The ACP driver's whole job is a JSON-RPC conversation, so the tests hold up the
 * other end of a real one over real pipes rather than mocking the transport.
 * Behaviour is chosen with FAKE_ACP_MODE.
 */

const mode = process.env.FAKE_ACP_MODE ?? 'text';
const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);

let nextId = 1000;
/** Per session. A global would make a switch on one thread look like it applied to every other. */
const sessionModel = new Map();
const sessions = new Set();
const sessionMounts = new Map();
/** Permission requests we sent and are still waiting on. */
const awaitingPermission = new Map();
/** File writes we sent and are still waiting on. */
const awaitingWrite = new Map();

const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const chunk = (sessionId, text) =>
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

function finishPrompt(id, stopReason = 'end_turn') {
  send({
    id,
    result: {
      stopReason,
      usage: { inputTokens: 30, outputTokens: 4, cachedReadTokens: 8, totalTokens: 34 },
    },
  });
}

function onPrompt(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (mode === 'permission') {
    const rpcId = nextId++;
    awaitingPermission.set(rpcId, { promptId: id, sessionId });
    send({
      id: rpcId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: 'call_1', title: 'git status', kind: 'execute', rawInput: { command: 'git status' } },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    return; // Settles only once the client answers.
  }

  if (mode === 'mcp') {
    const names = (sessionMounts.get(sessionId) ?? []).map((server) => server.name).join(',');
    chunk(sessionId, `mcp:${names}`);
    finishPrompt(id);
    return;
  }

  if (mode === 'write-file') {
    const rpcId = nextId++;
    awaitingWrite.set(rpcId, { promptId: id, sessionId });
    send({
      id: rpcId,
      method: 'fs/write_text_file',
      params: {
        sessionId,
        path: process.env.FAKE_ACP_WRITE,
        content: 'runbook\n',
      },
    });
    return;
  }

  if (mode === 'tool') {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'README.md', kind: 'read' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: 'README.md', kind: 'read', status: 'in_progress' });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', title: 'README.md', kind: 'read', status: 'completed' });
    chunk(sessionId, 'I read the file.');
    finishPrompt(id);
    return;
  }

  // Default: echo the prompt back in two chunks, so streaming is observable.
  const model = sessionModel.get(sessionId) ?? '';
  chunk(sessionId, model ? `model:${model} ` : 'pong: ');
  chunk(sessionId, text.split('\n').pop() ?? '');
  finishPrompt(id);
}

function onMessage(msg) {
  // A response to a request we sent (only permissions today).
  if (msg.id !== undefined && msg.method === undefined) {
    const writing = awaitingWrite.get(msg.id);
    if (writing) {
      awaitingWrite.delete(msg.id);
      chunk(writing.sessionId, msg.error ? 'write failed' : 'wrote');
      finishPrompt(writing.promptId);
      return;
    }
    const waiting = awaitingPermission.get(msg.id);
    if (!waiting) return;
    awaitingPermission.delete(msg.id);
    const outcome = msg.result?.outcome ?? {};
    if (outcome.outcome === 'selected' && outcome.optionId === 'allow') {
      chunk(waiting.sessionId, 'Command ran.');
      finishPrompt(waiting.promptId);
    } else if (outcome.outcome === 'selected') {
      chunk(waiting.sessionId, 'Understood, I will not run it.');
      finishPrompt(waiting.promptId);
    } else {
      finishPrompt(waiting.promptId, 'cancelled');
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          agentInfo: { name: 'fake-acp', version: '1.0.0' },
        },
      });
      if (mode === 'crash') process.exit(4);
      break;

    case 'session/new': {
      const sessionId = `sess_${sessions.size + 1}`;
      sessions.add(sessionId);
      sessionMounts.set(sessionId, msg.params?.mcpServers ?? []);
      // Echoed back so a test can prove which mounts the harness passed through.
      const result = { sessionId, mcpServers: msg.params?.mcpServers ?? [] };
      if (mode === 'models') {
        result.models = {
          currentModelId: 'opencode-free:nemotron',
          availableModels: [
            { modelId: 'opencode-free:nemotron', name: 'Nemotron' },
            { modelId: 'openrouter:anthropic/claude', name: 'Claude' },
          ],
        };
      }
      send({ id: msg.id, result });
      break;
    }

    case 'session/set_model':
      if (mode === 'reject-model') {
        send({ id: msg.id, error: { code: -32602, message: 'model refused' } });
        break;
      }
      sessionModel.set(String(msg.params?.sessionId ?? ''), String(msg.params?.modelId ?? ''));
      send({ id: msg.id, result: {} });
      break;

    case 'session/prompt':
      onPrompt(msg.id, msg.params ?? {});
      break;

    case 'session/cancel': {
      // Cancel settles every prompt still open on that session.
      for (const [rpcId, waiting] of awaitingPermission) {
        if (waiting.sessionId !== msg.params?.sessionId) continue;
        awaitingPermission.delete(rpcId);
        finishPrompt(waiting.promptId, 'cancelled');
      }
      break;
    }

    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'not implemented' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      /* partial or junk line */
    }
  }
});

// Hold the process open: an ACP agent outlives any single turn.
setInterval(() => {}, 1000);
