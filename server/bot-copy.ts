import type { BotRecord } from '../shared/types.ts';

const DROP: (keyof BotRecord)[] = [
  'id',
  'threadId',
  'tasks',
  'createdAt',
  'resumeCursors',
  'alwaysAllow',
  'alwaysAllowLocalComputer',
  'unread',
  'activity',
  'busy',
  'spendConfirmedUsd',
  'rewound',
  'workFolder',
];

/**
 * Fields safe to copy onto a new bot. Remembered grants and a spend confirmation
 * belong to the bot the user actually approved, so the copy starts without them.
 */
export function botDuplicateFields(
  bot: BotRecord,
): Partial<BotRecord> & { name: string; modelSelection: BotRecord['modelSelection'] } {
  const copy: Partial<BotRecord> = { ...bot, name: `${bot.name} copy` };
  for (const key of DROP) delete copy[key];
  return copy as Partial<BotRecord> & { name: string; modelSelection: BotRecord['modelSelection'] };
}
