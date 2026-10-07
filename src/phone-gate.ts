/**
 * The phone panel's send / pay / delete gate.
 *
 * The denial note is a sentence ("Send, pay, and delete need…"). The action to
 * approve is the button the user clicked, kept beside that note.
 */

export type PhoneAction = 'send' | 'pay' | 'delete';

export interface PhoneGate {
  action: PhoneAction;
  note: string;
}

export function phoneGateAfterAsk(
  action: PhoneAction,
  result: { allowed: boolean; reason?: string },
): PhoneGate {
  return {
    action,
    note: result.allowed ? `${action} allowed` : result.reason ?? `${action} needs approval`,
  };
}

export function phoneGateAfterApprove(
  gate: PhoneGate,
  result: { allowed: boolean; reason?: string },
): PhoneGate {
  return {
    action: gate.action,
    note: result.allowed ? `${gate.action} approved` : result.reason ?? `${gate.action} still needs approval`,
  };
}

/** Body of the Approve click. `approved` is the explicit yes; the action is the one that was asked. */
export function approvalPost(gate: PhoneGate): { action: PhoneAction; approved: true } {
  return { action: gate.action, approved: true };
}
