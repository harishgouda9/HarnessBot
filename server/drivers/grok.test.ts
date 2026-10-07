import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { grokBuildArgs, grokHandsArgs, grokModelId } from './builtIn.ts';
import { toolTraceTitle } from './cli.ts';
import { defineCliDriver } from './cli.ts';
import { EventBus, recordEvents } from '../harness/bus.ts';
import type { DriverContext, RuntimeEvent, SendTurnInput } from '../contracts.ts';

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-cli.mjs');

describe('grokModelId', () => {
  it('maps the old picker ids onto Grok Build\'s current default', () => {
    expect(grokModelId('grok-4')).toBe('grok-4.6');
    expect(grokModelId('grok-4-fast')).toBe('grok-4.6');
    expect(grokModelId('grok-code')).toBe('grok-4.6');
    expect(grokModelId('grok-4.5')).toBe('grok-4.5');
    expect(grokModelId('grok-4.6')).toBe('grok-4.6');
  });
});

describe('grokBuildArgs', () => {
  const input = {
    threadId: 't1',
    turnId: 'turn-1',
    text: 'secret user prompt',
    system: 'you are zon',
    model: 'grok-4',
    cwd: '/tmp/work',
    effort: 'high' as const,
    transcript: [],
    integrations: {},
    signal: new AbortController().signal,
  };

  it('does not pass --stream-json, which Grok Build rejects as --prompt-json usage', () => {
    const args = grokBuildArgs({ input });
    expect(args).not.toContain('--stream-json');
    expect(args).not.toContain('--prompt-json');
    expect(args.join(' ')).not.toContain('secret user prompt');
    expect(args).toEqual(
      expect.arrayContaining([
        '--output-format',
        'streaming-messages-json',
        '--permission-mode',
        'acceptEdits',
        '--allow',
        'Edit',
        '--allow',
        'Write',
        '-m',
        'grok-4.6',
        '--cwd',
        '/tmp/work',
        '--effort',
        'high',
      ]),
    );
    expect(args).not.toContain('--always-approve');
  });

  it('sends desktop tools through grok agent stdio, not a flag headless grok rejects', () => {
    const args = grokHandsArgs('grok-4', 'high');
    expect(args).toEqual(['agent', '--no-leader', '-m', 'grok-4.6', '--reasoning-effort', 'high', 'stdio']);
    expect(grokBuildArgs({ input }).join(' ')).not.toContain('--mcp-config');
    expect(grokBuildArgs({ input }).join(' ')).not.toContain('--plugin-dir');
  });

  it('resumes with -r, not the old --session flag', () => {
    const args = grokBuildArgs({ input, resume: 'abc-session' });
    expect(args).toContain('-r');
    expect(args).toContain('abc-session');
    expect(args).not.toContain('--session');
  });
});

describe('toolTraceTitle', () => {
  it('names a write by its path and leaves the file body off the line', () => {
    expect(
      toolTraceTitle({
        file_path: 'C:\\Users\\haris\\AppData\\Local\\hermes\\harnessbot-data\\workspace\\youtube-shorts-ai-news\\WORKFLOW.md',
        content: 'the whole pipeline document',
      }),
    ).toBe('youtube-shorts-ai-news/WORKFLOW.md');
  });

  it('keeps a shell command to its first line', () => {
    expect(toolTraceTitle({ command: 'New-Item -ItemType Directory pipe\nSet-Content file "secret body"' })).toBe(
      'New-Item -ItemType Directory pipe',
    );
  });
});

describe('promptVia file', () => {
  it('delivers the prompt through --prompt-file so Grok Build enters headless mode', async () => {
    const driver = defineCliDriver({
      kind: 'grok',
      displayName: 'Grok',
      bin: 'grok',
      models: [{ id: 'grok-4.6', label: 'Grok 4.6', default: true }],
      capabilities: {},
      promptVia: 'file',
      interactiveStdin: false,
      buildArgs: () => [],
    });

    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const ctx: DriverContext = {
      instanceId: 'grok',
      displayName: 'Grok',
      emit: (event: RuntimeEvent) => bus.publish('grok', event),
      secret: () => undefined,
      dataDir: process.env.HB_DATA_DIR!,
    };
    const adapter = await driver.create({ command: FAKE_CLI }, ctx);
    const input: SendTurnInput = {
      threadId: `t_${Math.random().toString(36).slice(2)}`,
      turnId: 'turn-file',
      text: 'reply with the word ping',
      system: 'you are a test',
      model: 'grok-4.6',
      transcript: [],
      integrations: {},
      signal: new AbortController().signal,
    };
    await adapter.sendTurn(input);
    const events = recorder.events;
    expect(events.some((e) => e.type === 'turn.completed' && e.stopReason === 'completed')).toBe(true);
    expect(events.some((e) => e.type === 'runtime.error')).toBe(false);
    await adapter.dispose();
  });
});

describe('grok desktop tools', () => {
  it('hands the computer mount to the ACP session instead of dropping it', async () => {
    const fakeAcp = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'fake-acp.mjs');
    const driver = defineCliDriver({
      kind: 'grok',
      displayName: 'Grok',
      bin: 'grok',
      models: [{ id: 'grok-4.6', label: 'Grok 4.6', default: true }],
      capabilities: {},
      promptVia: 'file',
      interactiveStdin: false,
      buildArgs: () => ['unused'],
    });
    const bus = new EventBus();
    const recorder = recordEvents(bus);
    const ctx: DriverContext = {
      instanceId: 'grok-hands',
      displayName: 'Grok',
      emit: (event: RuntimeEvent) => bus.publish('grok', event),
      secret: () => undefined,
      dataDir: process.env.HB_DATA_DIR!,
    };
    const adapter = await driver.create({ command: fakeAcp, env: { FAKE_ACP_MODE: 'mcp' } }, ctx);
    const input: SendTurnInput = {
      threadId: `t_${Math.random().toString(36).slice(2)}`,
      turnId: 'turn-hands',
      text: 'open the desktop',
      system: 'you are a test',
      model: 'grok-4',
      effort: 'high',
      transcript: [],
      integrations: {
        localComputer: { transport: 'stdio', command: process.execPath, args: ['computer-driver.mjs'] },
      },
      signal: new AbortController().signal,
    };
    await adapter.sendTurn(input);
    const text = recorder.events
      .filter((event) => event.type === 'content.delta' && event.itemKind === 'assistant_text')
      .map((event) => (event.type === 'content.delta' ? (event.delta ?? '') : ''))
      .join('');
    expect(text).toContain('mcp:localComputer');
    expect(recorder.events.some((event) => event.type === 'runtime.error')).toBe(false);
    expect(recorder.events.some((event) => event.type === 'turn.completed' && event.stopReason === 'completed')).toBe(true);
    await adapter.dispose();
  });
});
