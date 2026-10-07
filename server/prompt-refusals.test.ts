import { describe, expect, it } from 'vitest';
import { approvals } from './approvals.ts';
import type { RuntimeEvent } from './contracts.ts';
import { store } from './store.ts';
import { systemPrompt } from './turns.ts';

describe('refusals in the prompt', () => {
  it('puts a recent refusal at the end of the system prompt', () => {
    const bot = store.createBot({ name: 'Nora', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    const event = {
      eventId: 'e',
      provider: 'fake',
      threadId: bot.threadId,
      createdAt: Date.now(),
      type: 'request.opened',
      requestKind: 'permission',
      toolName: 'Bash',
      summary: 'rm the notes',
      allowKey: 'Bash:rm',
      requestId: 'req_refusal_prompt',
    } as Extract<RuntimeEvent, { type: 'request.opened' }>;
    approvals.open(bot, event, 'fake');
    approvals.resolve(event.requestId!, 'rejected', 'user');
    const prompt = systemPrompt(bot);
    expect(prompt).toContain('Recent refusals');
    expect(prompt).toContain('rm the notes');
    expect(prompt.indexOf('Recent refusals')).toBeGreaterThan(prompt.indexOf(bot.name));
  });
});
