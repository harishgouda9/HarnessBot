/**
 * Threads that belong to a routine run in progress.
 *
 * A routine must not inherit auto-approve for computer use. The set is the
 * signal the approval broker reads; it holds no other policy.
 */

const threads = new Set<string>();

export function holdRoutineThread(threadId: string): void {
  threads.add(threadId);
}

export function releaseRoutineThread(threadId: string): void {
  threads.delete(threadId);
}

export function routineHoldsApprovals(threadId: string): boolean {
  return threads.has(threadId);
}
