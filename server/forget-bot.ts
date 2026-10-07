import fs from 'node:fs';
import path from 'node:path';
import { approvals } from './approvals.ts';
import { revokeInternalToken } from './internal-tokens.ts';
import { dataPath, removeThreadLogs } from './paths.ts';
import { forgetJobsForBot } from './jobs.ts';
import { deleteRoutinesForBot } from './routines.ts';
import { store } from './store.ts';
import { discardQueued, interrupt } from './turns.ts';

function attachmentFile(url: string): string | null {
  const name = path.basename(url);
  if (!name || name === '.' || name === '..') return null;
  const dir = path.resolve(dataPath('attachments'));
  const file = path.resolve(dir, name);
  const rel = path.relative(dir, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/**
 * Delete a bot and the data that belongs to it: transcripts are removed by the
 * store, and the raw event logs, attachments, routines, and internal token go with them.
 */
export async function forgetBot(botId: string): Promise<boolean> {
  const bot = store.getBot(botId);
  if (!bot) return false;
  const threadIds = [...new Set([bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)])];
  const files = new Set<string>();
  for (const threadId of threadIds) {
    for (const message of store.listMessages(threadId)) {
      for (const attachment of message.attachments ?? []) {
        const file = attachmentFile(attachment.url);
        if (file) files.add(file);
      }
    }
    discardQueued(threadId);
  }
  for (const threadId of threadIds) await interrupt(botId, threadId);
  approvals.cancelForBot(botId);
  deleteRoutinesForBot(botId);
  forgetJobsForBot(botId);
  store.deleteBot(botId);
  revokeInternalToken(botId);
  for (const threadId of threadIds) removeThreadLogs(threadId);
  for (const file of files) fs.rmSync(file, { force: true });
  return true;
}
