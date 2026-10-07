import { describe, expect, it } from 'vitest';
import { applyDictation, speechAvailability } from './dictation.ts';

describe('dictation', () => {
  it('inserts recognized text and does not send it', () => {
    expect(applyDictation('', '  open the log  ')).toEqual({ text: 'open the log', send: false });
    expect(applyDictation('hello', 'there')).toEqual({ text: 'hello there', send: false });
    expect(applyDictation('hello', '   ')).toEqual({ text: 'hello', send: false });
  });

  it('says when Windows speech is unavailable instead of inventing a transcript', () => {
    const missing = speechAvailability('win32', false);
    expect(missing.available).toBe(false);
    expect(missing.reason).toMatch(/Windows speech/);
    expect(speechAvailability('win32', true).available).toBe(true);
  });
});
