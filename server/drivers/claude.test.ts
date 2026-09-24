import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defineCliDriver, allowKeyFor } from './cli.ts';
import { EventBus, recordEvents } from '../harness/bus.ts';
import type { DriverContext, RuntimeEvent, SendTurnInput } from '../contracts.ts';

/**
 * Driver contract test against a scripted fake CLI — a real child process, real line
 * splitting, real stdin round-trip. Mocking child_process here would test the mock;
 * the bugs that actually happen live in the spawn path (HB-TRD-001 s4.3).
 */

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-cli.mjs');

const driver = defineCliDriver({
  kind: 'claude',
  displayName: 'Claude Code',
  bin: 'claude',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', default: true }],
  capabilities: { images: true, steer: true, queueing: true, computerMcp: true },
  interactiveStdin: true,
  buildArgs: ({ input, resume }) => ['-p', '--model', input.model, ...(resume ? ['--resume', resume] : [])],
});

function contextFor(bus: EventBus, mode?: string): { ctx: DriverContext; env: Record<string, string> } {
  const env: Record<string, string> = mode ? { FAKE_MODE: mode } : {};
  return {
    env,
    ctx: {
      instanceId: 'test',
      displayName: 'Test',
      emit: (event: RuntimeEvent) => bus.publish('claude', event),
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
    model: 'claude-opus-5',
    transcript: [],
    integrations: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function run(mode: string | undefined, input: SendTurnInput) {
  const bus = new EventBus();
  const recorder = recordEvents(bus);
  const { ctx, env } = contextFor(bus, mode);
  const adapter = await driver.create({ command: FAKE_CLI, env }, ctx);
  return { adapter, recorder, bus, run: adapter.sendTurn(input) };
}

describe('CLI driver contract', () => {
  it('reports available when the executable resolves', async () => {
    const bus = new EventBus();
    const { ctx } = contextFor(bus);
    const adapter = await driver.create({ command: FAKE_CLI }, ctx);
    const snapshot = await adapter.snapshot();
    expect(snapshot.state).toBe('available');
    expect(snapshot.capabilities.computerMcp).toBe(true);
    // Sign-in hints and "Test" run this, so it must be the binary, not the kind.
    expect(snapshot.bin).toBe('claude');
    await adapter.dispose();
  });

  it('reports unavailable with a next action when the CLI is missing', async () => {
    const bus = new EventBus();
    const { ctx } = contextFor(bus);
    const adapter = await driver.create({ command: 'definitely-not-installed-xyz' }, ctx);
    const snapshot = await adapter.snapshot();
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.errorCode).toBe('missing_cli');
    // The reason has to name the fix, not just the failure.
    expect(snapshot.reason).toMatch(/Settings/);
    // A missing CLI must not advertise tools it cannot mount.
    expect(snapshot.capabilities.computerMcp).toBe(false);
    await adapter.dispose();
  });

  it('normalises a streamed reply into deltas plus one completed item', async () => {
    const { adapter, recorder, run: pending } = await run('stream', turn('hello'));
    await pending;
    const deltas = recorder.events.filter((e) => e.type === 'content.delta');
    const completed = recorder.events.find((e) => e.type === 'item.completed');
    const done = recorder.events.find((e) => e.type === 'turn.completed');

    expect(deltas.length).toBeGreaterThan(1);
    expect(completed).toMatchObject({ itemKind: 'assistant_text', text: 'Hello from the fake CLI.' });
    expect(done).toMatchObject({ stopReason: 'completed' });
    await adapter.dispose();
  });

  it('banks usage only on turn.completed', async () => {
    const { adapter, recorder, run: pending } = await run(undefined, turn('ping'));
    await pending;
    const done = recorder.events.find((e) => e.type === 'turn.completed') as Extract<RuntimeEvent, { type: 'turn.completed' }>;
    expect(done.usage).toMatchObject({ input: 12, output: 7, cachedInput: 3 });
    await adapter.dispose();
  });

  it('emits tool items as activity, not as assistant text', async () => {
    const { adapter, recorder, run: pending } = await run('tool', turn('read the file'));
    await pending;
    expect(recorder.events.find((e) => e.type === 'item.started')).toMatchObject({ itemKind: 'tool', toolName: 'Read' });
    expect(recorder.events.find((e) => e.type === 'item.completed' && (e as any).itemKind === 'tool')).toMatchObject({ ok: true });
    await adapter.dispose();
  });

  it('round-trips a permission request over stdin and continues the turn', async () => {
    const input = turn('run git status');
    const { adapter, recorder, run: pending } = await run('permission', input);

    const opened = (await recorder.until((e) => e.type === 'request.opened')) as Extract<RuntimeEvent, { type: 'request.opened' }>;
    expect(opened.toolName).toBe('Bash');
    // The allow key is narrow: the tool plus the first token, never a blanket grant.
    expect(opened.allowKey).toBe('Bash:git');

    await adapter.answerRequest({ requestId: opened.requestId!, outcome: 'allowed-once', source: 'user' });
    await pending;

    const texts = recorder.events.filter((e) => e.type === 'item.completed').map((e) => (e as any).text);
    expect(texts).toContain('Command ran.');
    await adapter.dispose();
  });

  it('a denial reaches the CLI and the command does not run', async () => {
    const input = turn('run git status');
    const { adapter, recorder, run: pending } = await run('permission', input);
    const opened = await recorder.until((e) => e.type === 'request.opened');

    await adapter.answerRequest({ requestId: opened.requestId!, outcome: 'rejected', source: 'user' });
    await pending;

    const texts = recorder.events.filter((e) => e.type === 'item.completed').map((e) => (e as any).text);
    expect(texts.join(' ')).toContain('will not run it');
    expect(texts.join(' ')).not.toContain('Command ran');
    await adapter.dispose();
  });

  it('fails closed when a turn ends with a card still open', async () => {
    const input = turn('run git status');
    const { adapter, recorder, run: pending } = await run('permission', input);
    await recorder.until((e) => e.type === 'request.opened');

    // The user closed the window / the turn was interrupted: nobody can answer now.
    await adapter.interrupt(input.threadId);
    await pending;

    const resolved = recorder.events.find((e) => e.type === 'request.resolved') as Extract<RuntimeEvent, { type: 'request.resolved' }>;
    expect(resolved.outcome).toBe('unavailable');
    expect(resolved.source).toBe('system');
    await adapter.dispose();
  });

  it('settles the turn when the CLI dies mid-stream', async () => {
    const { adapter, recorder, run: pending } = await run('exit-early', turn('hello'));
    await pending;
    const done = recorder.events.find((e) => e.type === 'turn.completed');
    expect(done).toBeDefined();
    expect((done as any).stopReason).toBe('error');
    // Never hang: a dead child still produces a settled turn.
    expect(recorder.events.some((e) => e.type === 'session.exited')).toBe(true);
    await adapter.dispose();
  });

  it('treats an auth failure as setup, not as something to retry', async () => {
    const { adapter, recorder, run: pending } = await run('auth-fail', turn('hello'));
    await pending;
    const error = recorder.events.find((e) => e.type === 'runtime.error') as Extract<RuntimeEvent, { type: 'runtime.error' }>;
    expect(error.setup).toBe(true);
    expect(error.errorCode).toBe('invalid_credentials');
    await adapter.dispose();
  });

  it('does not read a CLI usage dump as an auth failure', async () => {
    const { adapter, recorder, run: pending } = await run('usage-dump', turn('hello'));
    await pending;
    const error = recorder.events.find((e) => e.type === 'runtime.error') as Extract<RuntimeEvent, { type: 'runtime.error' }>;
    // `login` appears in the subcommand list. Marking this setup strands the bot as dead.
    expect(error.setup).toBeFalsy();
    expect(error.errorCode).toBeUndefined();
    await adapter.dispose();
  });

  it('interrupt kills the child and reports the turn as interrupted', async () => {
    const input = turn('go forever');
    const { adapter, recorder, run: pending } = await run('slow', input);
    await recorder.until((e) => e.type === 'turn.started');
    await adapter.interrupt(input.threadId);
    await pending;
    expect(recorder.events.some((e) => e.type === 'turn.completed')).toBe(true);
    await adapter.dispose();
  });

  it('rejects invalid config synchronously in decodeConfig', () => {
    expect(() => driver.decodeConfig({ command: 42 })).toThrow(/command/);
    expect(() => driver.decodeConfig({ args: 'not-an-array' })).toThrow(/args/);
    expect(driver.decodeConfig({})).toEqual({ command: undefined, args: undefined, env: undefined });
  });
});

describe('allow keys', () => {
  it('narrows to the tool plus the first token', () => {
    expect(allowKeyFor('Bash', 'git status --short')).toBe('Bash:git');
    expect(allowKeyFor('Bash', 'rm -rf /')).toBe('Bash:rm');
    // No detail means the tool alone, never a wildcard.
    expect(allowKeyFor('Read')).toBe('Read');
  });
});
