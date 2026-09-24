import { describe, expect, it } from 'vitest';
import { composeTurnText, mimeForFilename } from './attachments.ts';

describe('composeTurnText', () => {
  it('joins context, the message, and attachment paths', () => {
    const text = composeTurnText('look at this', [{ id: 'a1', name: 'shot.png', mime: 'image/png', url: '/api/attachments/a1.png' }], 'the brief');
    expect(text).toContain('Context:\nthe brief');
    expect(text).toContain('look at this');
    expect(text).toContain('shot.png');
  });

  it('is just the attachment note when the user sent no text', () => {
    const text = composeTurnText('', [{ id: 'a1', name: 'clip.mp4', mime: 'video/mp4', url: '/api/attachments/a1.mp4' }]);
    expect(text.startsWith('Attached files:')).toBe(true);
    expect(text).toContain('clip.mp4');
  });
});

describe('mimeForFilename', () => {
  it('guesses common image, video and document types', () => {
    expect(mimeForFilename('a.png')).toBe('image/png');
    expect(mimeForFilename('a.MP4')).toBe('video/mp4');
    expect(mimeForFilename('a.pdf')).toBe('application/pdf');
    expect(mimeForFilename('a.bin')).toBe('application/octet-stream');
  });
});
