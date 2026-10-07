import { describe, expect, it } from 'vitest';
import { approvalPost, phoneGateAfterApprove, phoneGateAfterAsk } from './phone-gate.ts';

/**
 * The harness answers a denied send/pay/delete with a sentence that starts with
 * "Send", not with the action id. Approve has to post the action that was clicked.
 */
const DENIAL = 'Send, pay, and delete need an explicit approval before they run on the phone.';

describe('phone approval gate', () => {
  it('posts the clicked action when the denial note does not start with that action', () => {
    for (const action of ['send', 'pay', 'delete'] as const) {
      const gate = phoneGateAfterAsk(action, { allowed: false, reason: DENIAL });
      expect(gate.note).toBe(DENIAL);
      expect(gate.note.startsWith(action)).toBe(false);
      expect(approvalPost(gate)).toEqual({ action, approved: true });
    }
  });

  it('keeps the same action after the approval result comes back', () => {
    const asked = phoneGateAfterAsk('pay', { allowed: false, reason: DENIAL });
    const approved = phoneGateAfterApprove(asked, { allowed: true });
    expect(approved.action).toBe('pay');
    expect(approvalPost(approved)).toEqual({ action: 'pay', approved: true });
  });
});
