/**
 * One thin status for the open chat.
 * The task the person gave stays on the line. The step is whatever the bot is
 * doing now, or the last tool once the turn has settled.
 */

export type WorkTone = 'working' | 'needs-you' | 'failed' | 'idle';

export interface WorkLine {
  text: string;
  tone: WorkTone;
}

export interface WorkLineInput {
  activity?: string;
  /** Last things the person asked, oldest first. Status checks are skipped when a real ask is there. */
  userTexts?: string[];
  pending?: { title?: string; subtitle?: string; tool?: string };
  liveDetail?: string;
  last?: { name: string; text?: string; ok?: boolean };
  job?: { status: string; title: string };
}

const STATUS_ASK = /^(have you|did you|any update|status\b|where is|can you give me update|give me an update|update\b)/i;

function clip(value: string, max: number): string {
  const one = value.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/** The task to keep on screen. A "have you done it?" does not replace the task it asks about. */
export function taskSubject(texts: string[]): string {
  const recent = texts.map((text) => text.trim()).filter(Boolean).slice(-8);
  const real = recent.filter((text) => !STATUS_ASK.test(text));
  const pool = real.length ? real : recent;
  const best = pool.reduce((longest, text) => (text.length > longest.length ? text : longest), '');
  return clip(best, 72);
}

export function workLine(input: WorkLineInput): WorkLine | null {
  const subject = taskSubject(input.userTexts ?? []);
  let step = '';
  let tone: WorkTone = 'idle';

  if (input.pending) {
    const what = [input.pending.tool || input.pending.title, input.pending.subtitle].filter(Boolean).join(' · ');
    step = clip(`Needs you · ${what || 'approval'}`, 96);
    tone = 'needs-you';
  } else if (input.activity === 'working' || input.activity === 'waiting-on-you') {
    step = input.liveDetail
      ? clip(input.liveDetail, 96)
      : input.activity === 'waiting-on-you'
        ? 'Waiting on you'
        : 'Working';
    tone = input.activity === 'waiting-on-you' ? 'needs-you' : 'working';
  } else if (input.last) {
    const flag = input.last.ok === false ? 'failed' : 'done';
    step = clip([input.last.name, flag, input.last.text].filter(Boolean).join(' · '), 96);
    tone = input.last.ok === false ? 'failed' : 'idle';
  } else if (input.job) {
    step = clip(`${input.job.status === 'active' ? 'In progress' : 'Queued'} · ${input.job.title}`, 96);
    tone = input.job.status === 'active' ? 'working' : 'idle';
  }

  if (!subject && !step) return null;
  // The task stays up after the turn. A one-word hello does not become a status bar.
  if (!step) {
    if (subject.length < 24) return null;
    return { text: subject, tone: 'idle' };
  }
  const text = subject ? `${subject} — ${step}` : step;
  return { text: clip(text, 160), tone };
}

/**
 * The status line only cares about the ask on screen. A failed tool from an
 * earlier turn stays in the transcript and does not keep the red line up.
 * Messages are oldest first. Setup and timeout never count, same as before.
 */
export function activityForStatus<T extends { at?: number; role?: string; kind?: string; tool?: { name?: string } }>(
  messages: T[],
): T | undefined {
  const lastUserAt = [...messages].reverse().find((m) => m.role === 'user' && m.kind === 'text')?.at ?? 0;
  return [...messages].reverse().find((m) => {
    if (m.kind !== 'activity' || !m.tool?.name) return false;
    if (m.tool.name === 'setup' || m.tool.name === 'timeout') return false;
    return (m.at ?? 0) >= lastUserAt;
  });
}

/**
 * The busy strip already says this bot is working. Drop a repeated working
 * prefix, and hide the line when that was the whole message. workLine() still
 * says "Working"; other locales pass their own word for the same step.
 */
export function workLineShown(text: string, tone: WorkTone, sameAsStrip: boolean, workingWord = 'Working'): string | null {
  if (!sameAsStrip || tone !== 'working') return text;
  let next = text;
  for (const word of new Set([workingWord, 'Working'])) {
    const prefix = `${word} · `;
    if (next.startsWith(prefix)) next = next.slice(prefix.length);
  }
  if (!next || next === workingWord || next === 'Working') return null;
  return next;
}
