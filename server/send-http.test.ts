import { describe, expect, it } from 'vitest';
import { rejectionForSendError } from './send-http.ts';

describe('rejectionForSendError', () => {
  it('lets a successful send stay a 200', () => {
    expect(rejectionForSendError(undefined)).toBeNull();
  });

  it('maps missing records, validation, the spend cap, and a busy engine', () => {
    expect(rejectionForSendError('no such bot')).toEqual({ status: 404, message: 'no such bot' });
    expect(rejectionForSendError('no such message')).toEqual({ status: 404, message: 'no such message' });
    expect(rejectionForSendError('text is required')).toEqual({ status: 400, message: 'text is required' });
    expect(rejectionForSendError('spend-cap')?.status).toBe(409);
    expect(rejectionForSendError('spend-cap')?.message).toMatch(/Spend cap reached/);
    expect(rejectionForSendError('busy')).toEqual({
      status: 409,
      message: 'This bot is busy and this engine cannot queue another message.',
    });
    expect(rejectionForSendError('engine offline')).toEqual({ status: 409, message: 'engine offline' });
  });
});
