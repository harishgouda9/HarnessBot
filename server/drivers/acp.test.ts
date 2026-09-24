import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineAcpDriver, mcpServersFor, mergeCatalog, readAcpModels } from './acp.ts';
import { EventBus, recordEvents } from '../harness/bus.ts';
import type { DriverContext, RuntimeEvent, SendTurnInput } from '../contracts.ts';

/**
 * ACP driver contract test against a scripted fake agent — a real child process and a
 * real JSON-RPC round trip over real pipes. The bugs that matter here live in the
 * conversation (session reuse, permission plumbing, settling a dead agent), and a
 * mocked transport would test the mock.
 */

const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-acp.mjs');

const driver = defineAcpDriver({
  kind: 'customAcp',
  displayName: 'Custom ACP',
  bin: 'acp',
  acpArgs: [],
  models: [{ id: 'default', label: 'Default', default: true }],
  capabilities: { queueing: true, customMcp: true },
});

function contextFor(bus: EventBus, mode?: string): { ctx: DriverContext; env: Record<string, string> } {
  return {
    env: mode ? { FAKE_ACP_MODE: mode } : {},
    ctx: {
      instanceId: 'test',
      displayName: 'Test',
      emit: (event: RuntimeEvent) => bus.publish('customAcp', event),
      secret: () => undefined,
      dataDir: process.env.HB_DATA_DIR!,
    },
  };
}

function turn(text: string, overrides: Partial<SendTurnInput> = {}): SendTurnInput {
  return {
    threadId: `t_${Math.random().toString(36).slice(2)}`,
    turnId: 'turn-1',
    text,
    system: 'you are a test',
    model: 'default',
    transcript: [],
    integrations: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function adapterFor(bus: EventBus, mode?: string) {
  const { ctx, env } = contextFor(bus, mode);
  return driver.create({ command: FAKE_ACP, env }, ctx);
}

const deltas = (events: RuntimeEvent[]): string =>
  events
    .filter((e) => e.type === 'content.delta')
    .map((e) => (e as Extract<RuntimeEvent, { type: 'content.delta' }>).delta)
    .join('');

describe('ACP driver contract', () => {
  it('reports available with the executable, without starting the agent', async () => {
    const bus = new EventBus();
    const { ctx } = contextFor(bus);
    const adapter = await driver.create({ command: FAKE_ACP }, ctx);
    const snapshot = await adapter.snapshot();
    expect(snapshot.state).toBe('available');
    expect(snapshot.bin).toBe('acp');
    expect(snapshot.capabilities.customMcp).toBe(true);
    // Booting an ACP agent costs tens of seconds; the roster must not pay it.
    expect(recordEvents(bus).events).toHaveLength(0);
    await adapter.dispose();
  });

  it('reports unavailable with a next action when the CLI is missing', async () => {
    const bus = new EventBus();
    const { ctx } = contextFor(bus);
    const adapter = await driver.create({ command: 'definitely-not-installed-xyz' }, ctx);
    const snapshot = await adapter.snapshot();
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.errorCode).toBe('missing_cli');
    expect(snapshot.reason).toMatch(/Settings/);
    expect(snapshot.capabilities.customMcp).toBe(false);
    await adapter.dispose();
  });

  it('streams the reply and banks usage on turn.completed', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    await adapter.sendTurn(turn('hello'));

    expect(deltas(recorder.events)).toContain('pong: hello');
    expect(recorder.events.find((e) => e.type === 'turn.completed')).toMatchObject({
      stopReason: 'completed',
      usage: { input: 30, output: 4, cachedInput: 8 },
    });
    await adapter.dispose();
  });

  it('reuses one session across turns instead of starting over each time', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    const threadId = 't_shared';
    await adapter.sendTurn(turn('one', { threadId }));
    await adapter.sendTurn(turn('two', { threadId }));

    // Two sessions would mean the agent met the user cold on the second message.
    expect(recorder.events.filter((e) => e.type === 'session.started')).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === 'turn.completed')).toHaveLength(2);
    await adapter.dispose();
  });

  it('opens a new session when desktop tools appear after the first turn', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    const threadId = 't_hands_later';
    await adapter.sendTurn(turn('hello', { threadId }));
    await adapter.sendTurn(
      turn('now drive the desktop', {
        threadId,
        integrations: {
          localComputer: { transport: 'stdio', command: process.execPath, args: ['computer-driver.mjs'], env: { TOKEN: 'x' } },
        },
      }),
    );
    expect(recorder.events.filter((e) => e.type === 'session.started')).toHaveLength(2);
    await adapter.dispose();
  });

  it('gives each thread its own session', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    await adapter.sendTurn(turn('one', { threadId: 't_a' }));
    await adapter.sendTurn(turn('two', { threadId: 't_b' }));

    const ids = recorder.events
      .filter((e) => e.type === 'session.started')
      .map((e) => (e as Extract<RuntimeEvent, { type: 'session.started' }>).sessionId);
    expect(new Set(ids).size).toBe(2);
    await adapter.dispose();
  });

  it('dropSession forces the next turn to open a fresh one', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    const threadId = 't_rewound';
    await adapter.sendTurn(turn('one', { threadId }));
    await adapter.dropSession(threadId);
    await adapter.sendTurn(turn('two', { threadId }));

    // That is what a rewind needs: the replayed branch must not land in the old session.
    expect(recorder.events.filter((e) => e.type === 'session.started')).toHaveLength(2);
    await adapter.dispose();
  });

  it('replays the visible branch into a new session and not into an existing one', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    const threadId = 't_replay';
    const transcript = [{ role: 'user' as const, text: 'earlier question' }];
    await adapter.sendTurn(turn('first', { threadId, transcript }));
    await adapter.sendTurn(turn('second', { threadId, transcript }));

    const text = deltas(recorder.events);
    // The fake echoes the last prompt line, so a replayed preamble would show up twice.
    expect(text).toContain('pong: first');
    expect(text).toContain('pong: second');
    await adapter.dispose();
  });

  it('reports no resume cursor, so the harness keeps replaying the branch', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus);
    await adapter.sendTurn(turn('hello', { threadId: 't_cursor' }));

    const started = recorder.events.find((e) => e.type === 'session.started') as Extract<
      RuntimeEvent,
      { type: 'session.started' }
    >;
    expect(started.sessionId).toBeTruthy();
    // Sessions live in memory only. A stored cursor would make turns.ts send an empty
    // transcript, and a harness restart would then open a blank session with no history.
    expect(started.resumeCursor).toBeUndefined();
    await adapter.dispose();
  });

  it('surfaces tool calls as activity, not as assistant text', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'tool');
    await adapter.sendTurn(turn('read the file'));

    expect(recorder.events.find((e) => e.type === 'item.started')).toMatchObject({ itemKind: 'tool', title: 'README.md' });
    const done = recorder.events.find((e) => e.type === 'item.completed');
    expect(done).toMatchObject({ itemKind: 'tool', ok: true });
    // in_progress is noise; only the settled call earns a line.
    expect(recorder.events.filter((e) => e.type === 'item.completed')).toHaveLength(1);
    await adapter.dispose();
  });

  it('round-trips a permission request and continues the turn', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'permission');
    const input = turn('run git status');
    const pending = adapter.sendTurn(input);

    const opened = (await recorder.until((e) => e.type === 'request.opened')) as Extract<
      RuntimeEvent,
      { type: 'request.opened' }
    >;
    expect(opened.toolName).toBe('git status');
    // The allow key stays narrow: the tool plus the first token, never a blanket grant.
    expect(opened.allowKey).toBe('git status:git');
    expect(opened.choices?.map((c) => c.id)).toEqual(['allow', 'deny']);

    await adapter.answerRequest({ requestId: opened.requestId!, outcome: 'allowed-once', source: 'user' });
    await pending;

    expect(deltas(recorder.events)).toContain('Command ran.');
    await adapter.dispose();
  });

  it('a denial reaches the agent and the command does not run', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'permission');
    const pending = adapter.sendTurn(turn('run git status'));
    const opened = await recorder.until((e) => e.type === 'request.opened');

    await adapter.answerRequest({ requestId: opened.requestId!, outcome: 'rejected', source: 'user' });
    await pending;

    const text = deltas(recorder.events);
    expect(text).toContain('will not run it');
    expect(text).not.toContain('Command ran');
    await adapter.dispose();
  });

  it('fails closed when a turn ends with a card still open', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'permission');
    const input = turn('run git status');
    const pending = adapter.sendTurn(input);
    await recorder.until((e) => e.type === 'request.opened');

    await adapter.interrupt(input.threadId);
    await pending;

    const resolved = recorder.events.find((e) => e.type === 'request.resolved') as Extract<
      RuntimeEvent,
      { type: 'request.resolved' }
    >;
    expect(resolved.outcome).toBe('unavailable');
    expect(resolved.source).toBe('system');
    await adapter.dispose();
  });

  it('settles the turn when the agent dies instead of hanging the UI', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'crash');
    await adapter.sendTurn(turn('hello'));

    expect(recorder.events.find((e) => e.type === 'turn.completed')).toMatchObject({ stopReason: 'error' });
    expect(recorder.events.some((e) => e.type === 'runtime.error')).toBe(true);
    await adapter.dispose();
  });

  it('reports a missing CLI as setup, not as something to retry', async () => {
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const { ctx } = contextFor(bus);
    const adapter = await driver.create({ command: 'definitely-not-installed-xyz' }, ctx);
    await adapter.sendTurn(turn('hello'));

    const error = recorder.events.find((e) => e.type === 'runtime.error') as Extract<
      RuntimeEvent,
      { type: 'runtime.error' }
    >;
    expect(error.setup).toBe(true);
    expect(error.errorCode).toBe('missing_cli');
    expect(recorder.events.find((e) => e.type === 'turn.completed')).toMatchObject({ stopReason: 'error' });
    await adapter.dispose();
  });

  it('rejects invalid config synchronously in decodeConfig', () => {
    expect(() => driver.decodeConfig({ command: 42 })).toThrow(/command/);
    expect(() => driver.decodeConfig({ args: 'not-an-array' })).toThrow(/args/);
    expect(driver.decodeConfig({})).toEqual({ command: undefined, args: undefined, env: undefined });
  });

  it('reads every provider Hermes advertised, and a pick is sent as session/set_model', async () => {
    const listed = readAcpModels({
      models: {
        currentModelId: 'opencode-free:nemotron',
        availableModels: [
          { modelId: 'opencode-free:nemotron', name: 'Nemotron' },
          { modelId: 'openrouter:anthropic/claude', name: 'Claude' },
        ],
      },
    });
    expect(listed.map((m) => m.label)).toEqual(['opencode-free · Nemotron', 'openrouter · Claude']);
    expect(mergeCatalog([{ id: 'default', label: 'As configured', default: true }], listed).map((m) => m.id)).toEqual([
      'opencode-free:nemotron',
      'openrouter:anthropic/claude',
      'default',
    ]);

    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const adapter = await adapterFor(bus, 'models');
    await adapter.refreshModels?.();
    const snapshot = await adapter.snapshot();
    expect(snapshot.models.map((m) => m.id)).toEqual(['opencode-free:nemotron', 'openrouter:anthropic/claude', 'default']);

    await adapter.sendTurn(turn('hello', { model: 'openrouter:anthropic/claude' }));
    expect(deltas(recorder.events)).toContain('model:openrouter:anthropic/claude');
    await adapter.dispose();
  });
});

describe('ACP mcp mounts', () => {
  it('carries stdio and http mounts in the shape ACP expects', () => {
    const servers = mcpServersFor({
      composio: { transport: 'stdio', command: 'npx', args: ['composio'], env: { TOKEN: 'x' } },
      agents: { transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { authorization: 'Bearer y' } },
      custom: { mine: { transport: 'stdio', command: 'my-server', args: [] } },
    });

    expect(servers).toContainEqual({
      name: 'composio',
      command: 'npx',
      args: ['composio'],
      env: [{ name: 'TOKEN', value: 'x' }],
    });
    expect(servers).toContainEqual({
      type: 'http',
      name: 'agents',
      url: 'http://127.0.0.1:1/mcp',
      headers: [{ name: 'authorization', value: 'Bearer y' }],
    });
    // Custom mounts are named by their own key, not nested under "custom".
    expect(servers).toContainEqual({ name: 'mine', command: 'my-server', args: [], env: [] });
  });
});
