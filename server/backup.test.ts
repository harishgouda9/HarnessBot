import { describe, expect, it } from 'vitest';
import { buildRosterBackup } from './backup.ts';
import { setSecret } from './config.ts';
import { addMemory } from './memory.ts';
import { createRoutine } from './routines.ts';
import { confirmSkill, stageSkill } from './skills.ts';
import { store } from './store.ts';
import { createWebhook } from './webhooks.ts';

describe('buildRosterBackup', () => {
  it('keeps bots, memory, skills, and routines, and drops secrets', () => {
    const secret = 'hb-test-secret-9f3c2a';
    setSecret('xai.key', secret);
    const bot = store.createBot({
      name: 'Ada',
      title: 'Navigator',
      description: 'Keeps the morning digest.',
      modelSelection: { instanceId: 'fake', model: 'fake-1' },
    });
    const memory = addMemory({
      scope: 'bot',
      botId: bot.id,
      kind: 'fact',
      text: 'Ada likes morning digests',
      source: 'user',
    });
    const staged = stageSkill(bot.id, 'field-notes', 'Notes from the watch', 'Watch the lighthouse and write down what changed.');
    const skill = confirmSkill(bot.id, staged.name, staged.sha256);
    const routine = createRoutine({
      name: 'Morning digest',
      prompt: 'Summarise overnight.',
      botId: bot.id,
      runOn: 'harnessbot',
      enabled: true,
      schedule: { kind: 'daily', time: '08:00', weekdays: [1, 2, 3, 4, 5] },
      durationMinutes: 20,
    });
    const hook = createWebhook('digest hook', routine.id);

    const backup = buildRosterBackup();
    const json = JSON.stringify(backup);

    expect(json).not.toContain(secret);
    expect(json).not.toContain(hook.secret);
    expect(json).not.toContain(hook.record.secretHash);
    expect(json).not.toContain('secretHash');
    expect(backup.bots).toEqual(expect.arrayContaining([expect.objectContaining({ id: bot.id, name: 'Ada' })]));
    expect(backup.memory).toEqual(expect.arrayContaining([expect.objectContaining({ id: memory.id, text: memory.text })]));
    expect(backup.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: skill.name, body: skill.body })]));
    expect(backup.routines).toEqual(expect.arrayContaining([expect.objectContaining({ id: routine.id, name: routine.name })]));
  });
});
