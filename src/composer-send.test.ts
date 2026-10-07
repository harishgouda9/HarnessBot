import { describe, expect, it } from 'vitest';
import { draftAfterFailure, draftAfterSend } from './composer-send.ts';

describe('draftAfterSend', () => {
  const draft = {
    text: 'hello',
    files: [{ id: 'a', name: 'note.txt', mime: 'text/plain', url: '/api/attachments/a.txt' }],
    context: 'the brief',
  };

  it('clears the draft when the send is accepted', () => {
    expect(draftAfterSend(draft, null)).toEqual({ draft: { text: '', files: [], context: '' }, error: null });
  });

  it('restores the draft and keeps the server message when the send is refused', () => {
    const result = draftAfterSend(draft, new Error('This bot is busy and this engine cannot queue another message.'));
    expect(result.draft).toEqual(draft);
    expect(result.error).toMatch(/busy/);
  });

  it('keeps a draft typed after Send when the failure arrives late', () => {
    const failed = draft;
    const newer = { text: 'a second thought', files: [], context: '' };
    expect(draftAfterFailure(failed, newer, true)).toEqual(newer);
    expect(draftAfterFailure(failed, { text: '', files: [], context: '' }, false)).toEqual(failed);
  });
});
