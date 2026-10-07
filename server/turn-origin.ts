import type { InitiatorKind } from '../shared/types.ts';

/**
 * Who started the turn now running on a thread.
 *
 * The approval broker reads this when a tool asks. A grant clicked in chat
 * (Always allow) applies to a person or a job the user queued. It does not
 * apply to a routine or a handoff, which run with nobody at the keyboard.
 */

export interface TurnOrigin {
  kind: InitiatorKind;
  id?: string;
  label?: string;
}

const origins = new Map<string, TurnOrigin>();

export function noteTurnOrigin(threadId: string, origin: TurnOrigin): void {
  if (!threadId) return;
  origins.set(threadId, {
    kind: origin.kind,
    ...(origin.id ? { id: origin.id } : {}),
    ...(origin.label ? { label: origin.label } : {}),
  });
}

/** Unset means a person. Tests and ordinary chat both land here. */
export function turnOrigin(threadId: string): TurnOrigin {
  return origins.get(threadId) ?? { kind: 'person' };
}

export function resetTurnOrigins(): void {
  origins.clear();
}
