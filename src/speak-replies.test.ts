import { describe, expect, it } from 'vitest';
import type { BotRecord, Message } from '../shared/types.ts';
import { replyToSpeak } from './speak-replies.ts';

const bot = {
  id: 'bot_1',
  threadId: 't_main',
  tasks: [{ threadId: 't_task', title: 'Task', createdAt: 1, resumeCursors: {} }],
  name: 'Ada',
  speakReplies: true,
  voice: '',
  modelSelection: { instanceId: 'grok', model: 'grok-4' },
} as BotRecord;

const reply = { id: 'm', at: 1, role: 'bot', kind: 'text', text: 'The lighthouse is lit.' } as Message;

describe('replyToSpeak', () => {
  it('speaks a bot reply on the bot thread or a task thread, using the workspace voice as fallback', () => {
    expect(replyToSpeak([bot], 'voice_workspace', 't_main', reply)).toEqual({
      text: 'The lighthouse is lit.',
      voice: 'voice_workspace',
    });
    expect(replyToSpeak([{ ...bot, voice: 'voice_bot' }], 'voice_workspace', 't_task', reply)?.voice).toBe('voice_bot');
  });

  it('stays quiet for user text, tool cards, a toggle that is off, or no voice at all', () => {
    expect(replyToSpeak([bot], 'voice_workspace', 't_main', { ...reply, role: 'user' })).toBeNull();
    expect(replyToSpeak([bot], 'voice_workspace', 't_main', { ...reply, kind: 'options' })).toBeNull();
    expect(replyToSpeak([{ ...bot, speakReplies: false }], 'voice_workspace', 't_main', reply)).toBeNull();
    expect(replyToSpeak([bot], '', 't_main', reply)).toBeNull();
    expect(replyToSpeak([bot], 'voice_workspace', 't_other', reply)).toBeNull();
    expect(replyToSpeak([bot], 'voice_workspace', 't_main', reply, reply.at + 1)).toBeNull();
  });
});
