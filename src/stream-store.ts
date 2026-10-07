import { useSyncExternalStore } from 'react';

/**
 * Display-only streaming text and inspector trace.
 *
 * Token deltas and runtime events used to go through the chat reducer, which
 * re-rendered every panel on every token. They are not transcript: the finished
 * reply still arrives as a message. This buffer paints them at most once per
 * frame, and only the inspector (plus the chat scroller) subscribes.
 */

export interface RuntimeTrace {
  at: number;
  threadId: string;
  type: string;
  detail: string;
}

const TRACE_CAP = 300;
const EMPTY_TRACE: RuntimeTrace[] = [];

type Op =
  | { type: 'delta'; threadId: string; text: string }
  | { type: 'clear'; threadId: string }
  | { type: 'trace'; entry: RuntimeTrace };

const queue: Op[] = [];
const textByThread = new Map<string, string>();
const textSnap = new Map<string, string>();
const traceSnap = new Map<string, RuntimeTrace[]>();
const listeners = new Map<string, Set<() => void>>();
let trace: RuntimeTrace[] = [];

let scheduled = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let rafId = 0;

function cancelSchedule(): void {
  scheduled = false;
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (rafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (!hidden && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      scheduled = false;
      flush();
    });
    return;
  }
  // Hidden tabs and the test runner have no paint frame. A short timer still
  // coalesces a burst into one notification.
  timer = setTimeout(() => {
    timer = undefined;
    scheduled = false;
    flush();
  }, 100);
  // Node timers can leave the event loop. The DOM lib types this return as a number.
  (timer as unknown as { unref?: () => void }).unref?.();
}

function tracesEqual(prev: RuntimeTrace[], next: RuntimeTrace[]): boolean {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) if (prev[i] !== next[i]) return false;
  return true;
}

function publish(threadId: string): boolean {
  let changed = false;
  const nextText = textByThread.get(threadId) ?? '';
  if ((textSnap.get(threadId) ?? '') !== nextText) {
    if (nextText) textSnap.set(threadId, nextText);
    else textSnap.delete(threadId);
    changed = true;
  }
  const nextTrace = trace.filter((entry) => entry.threadId === threadId);
  const prevTrace = traceSnap.get(threadId) ?? EMPTY_TRACE;
  if (!tracesEqual(prevTrace, nextTrace)) {
    if (nextTrace.length) traceSnap.set(threadId, nextTrace);
    else traceSnap.delete(threadId);
    changed = true;
  }
  return changed;
}

function notify(threadId: string): void {
  const set = listeners.get(threadId);
  if (!set) return;
  for (const listener of set) listener();
}

function flush(): void {
  if (queue.length === 0) return;
  const ops = queue.splice(0, queue.length);
  const dirty = new Set<string>();
  const traceBefore = new Set(trace.map((entry) => entry.threadId));
  let traceChanged = false;
  for (const op of ops) {
    if (op.type === 'delta') {
      textByThread.set(op.threadId, (textByThread.get(op.threadId) ?? '') + op.text);
      dirty.add(op.threadId);
    } else if (op.type === 'clear') {
      if (textByThread.get(op.threadId)) {
        textByThread.set(op.threadId, '');
        dirty.add(op.threadId);
      }
    } else {
      trace = [op.entry, ...trace].slice(0, TRACE_CAP);
      traceChanged = true;
    }
  }
  if (traceChanged) {
    for (const threadId of traceBefore) dirty.add(threadId);
    for (const entry of trace) dirty.add(entry.threadId);
  }
  for (const threadId of dirty) {
    if (publish(threadId)) notify(threadId);
  }
}

export function pushDelta(threadId: string, delta: string): void {
  if (!threadId || !delta) return;
  queue.push({ type: 'delta', threadId, text: delta });
  schedule();
}

export function clearStream(threadId: string): void {
  if (!threadId) return;
  queue.push({ type: 'clear', threadId });
  schedule();
}

export function pushTrace(entry: RuntimeTrace): void {
  if (!entry.threadId) return;
  queue.push({ type: 'trace', entry });
  schedule();
}

/** Published text. Empty until the next frame flushes a pending burst. */
export function getStreaming(threadId: string): string {
  return textSnap.get(threadId) ?? '';
}

export function getTrace(threadId: string): RuntimeTrace[] {
  return traceSnap.get(threadId) ?? EMPTY_TRACE;
}

export function subscribeThread(threadId: string, onStoreChange: () => void): () => void {
  let set = listeners.get(threadId);
  if (!set) {
    set = new Set();
    listeners.set(threadId, set);
  }
  set.add(onStoreChange);
  return () => {
    set!.delete(onStoreChange);
    if (set!.size === 0) listeners.delete(threadId);
  };
}

/** Apply a pending burst now. Tests use this instead of waiting out the frame. */
export function flushStreamStore(): void {
  cancelSchedule();
  flush();
}

export function resetStreamStore(): void {
  cancelSchedule();
  queue.length = 0;
  textByThread.clear();
  textSnap.clear();
  traceSnap.clear();
  listeners.clear();
  trace = [];
}

export function useStreaming(threadId: string): string {
  return useSyncExternalStore(
    (onStoreChange) => subscribeThread(threadId, onStoreChange),
    () => getStreaming(threadId),
    () => '',
  );
}

export function useTrace(threadId: string): RuntimeTrace[] {
  return useSyncExternalStore(
    (onStoreChange) => subscribeThread(threadId, onStoreChange),
    () => getTrace(threadId),
    () => EMPTY_TRACE,
  );
}
