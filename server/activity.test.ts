import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activityBeats } from '../shared/activity.ts';
import { threadActivity } from './activity-feed.ts';
import { store } from './store.ts';

describe('activity strip', () => {
  it('keeps a command and an exit code, and a file path without its contents', () => {
    const beats = activityBeats([
      { at: 1, kind: 'activity', text: 'git status', tool: { name: 'Bash', ok: true } },
      { at: 2, kind: 'activity', text: 'notes/plan.md\nsecret file body', tool: { name: 'Read', ok: true } },
      { at: 3, kind: 'activity', text: 'warming up', tool: { name: 'setup' } },
      { at: 4, kind: 'text', text: 'hello' },
    ]);
    expect(beats).toEqual([
      { at: 1, tool: 'Bash', command: 'git status', exitCode: 0 },
      { at: 2, tool: 'Read', exitCode: 0, path: 'notes/plan.md' },
    ]);
    expect(JSON.stringify(beats)).not.toContain('secret file body');
  });

  it('adds the file size and does not read the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-activity-'));
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'not for the strip');
    const bot = store.createBot({ name: 'Hands', modelSelection: { instanceId: 'fake', model: 'fake-1' } });
    store.appendMessage(bot.threadId, {
      role: 'bot',
      kind: 'activity',
      text: `${file}\nnot for the strip`,
      tool: { name: 'Write', ok: false },
    });
    const beats = threadActivity(bot.threadId);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ tool: 'Write', path: file, bytes: fs.statSync(file).size, exitCode: 1 });
    expect(JSON.stringify(beats)).not.toContain('not for the strip');
  });
});
