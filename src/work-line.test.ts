import { describe, expect, it } from 'vitest';
import { activityForStatus, taskSubject, workLine, workLineShown } from './work-line.ts';

describe('work line', () => {
  it('keeps the task and skips a later status check', () => {
    expect(
      taskSubject([
        'can i create a youtube automation workflow, if yes can build it',
        'Ai news, youtube shorts',
        'have you done creating pipeline ?',
      ]),
    ).toBe('can i create a youtube automation workflow, if yes can build it');
  });

  it('shows the live step while working and the failure after the turn', () => {
    const texts = ['Build the AI news shorts pipeline'];
    expect(workLine({ activity: 'working', userTexts: texts, liveDetail: 'Write · youtube-shorts-ai-news/runbook.md' })).toEqual({
      text: 'Build the AI news shorts pipeline — Write · youtube-shorts-ai-news/runbook.md',
      tone: 'working',
    });
    expect(
      workLine({
        activity: 'idle',
        userTexts: texts,
        last: { name: 'Write', text: 'youtube-shorts-ai-news/runbook.md', ok: false },
      }),
    ).toMatchObject({ tone: 'failed' });
  });

  it('puts a pending allow ahead of the live tool', () => {
    const line = workLine({
      activity: 'waiting-on-you',
      userTexts: ['Build the pipeline'],
      pending: { tool: 'Write', subtitle: 'workspace/pipe/runbook.md' },
      liveDetail: 'Write · something else',
    });
    expect(line).toMatchObject({ tone: 'needs-you' });
    expect(line?.text).toContain('Needs you · Write · workspace/pipe/runbook.md');
  });

  it('keeps a real task on the line after the turn settles, and ignores a greeting', () => {
    expect(workLine({ activity: 'idle', userTexts: ['Build the AI news shorts pipeline'] })?.text).toBe(
      'Build the AI news shorts pipeline',
    );
    expect(workLine({ activity: 'idle', userTexts: ['hello'] })).toBeNull();
  });

  it('keeps a failed tool from this ask and drops one from an earlier ask', () => {
    const earlier = { at: 2, role: 'bot', kind: 'activity', tool: { name: 'error', ok: false }, text: 'Internal error' };
    const current = { at: 5, role: 'bot', kind: 'activity', tool: { name: 'Write', ok: false }, text: 'runbook.md' };
    expect(
      activityForStatus([
        { at: 1, role: 'user', kind: 'text', text: 'build the pipeline' },
        earlier,
        { at: 3, role: 'bot', kind: 'text', text: 'done' },
        { at: 4, role: 'user', kind: 'text', text: 'which model are you' },
        { at: 6, role: 'bot', kind: 'text', text: 'gpt-6-luna' },
      ]),
    ).toBeUndefined();
    expect(
      activityForStatus([
        { at: 1, role: 'user', kind: 'text', text: 'build the pipeline' },
        current,
        { at: 4, role: 'bot', kind: 'activity', tool: { name: 'setup', ok: false } },
        { at: 5, role: 'bot', kind: 'activity', tool: { name: 'timeout' } },
      ]),
    ).toBe(current);
    expect(
      activityForStatus([
        { at: 1, role: 'bot', kind: 'activity', tool: { name: 'setup' } },
        earlier,
      ]),
    ).toBe(earlier);
  });

  it('hides a repeated Working line when the busy strip already names this bot', () => {
    expect(workLineShown('Working · Write · runbook.md', 'working', true)).toBe('Write · runbook.md');
    expect(workLineShown('Working', 'working', true)).toBeNull();
    expect(workLineShown('Working · Write · runbook.md', 'working', false)).toBe('Working · Write · runbook.md');
    expect(workLineShown('Needs you · Write', 'needs-you', true)).toBe('Needs you · Write');
    expect(workLineShown('Arbeitet · Working', 'working', true, 'Arbeitet')).toBeNull();
    expect(workLineShown('Working', 'working', true, 'Arbeitet')).toBeNull();
    expect(workLineShown('Arbeitet · Build — Write · runbook.md', 'working', true, 'Arbeitet')).toBe(
      'Build — Write · runbook.md',
    );
  });
});
