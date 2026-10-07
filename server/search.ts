import type { Message, ThreadId } from '../shared/types.ts';
import { store } from './store.ts';

export type SearchCard = 'approval' | 'tool' | 'goal';

export interface SearchFilter {
  query: string;
  botId?: string;
  roomId?: string;
  from?: number;
  to?: number;
  card?: SearchCard;
  limit?: number;
}

/** Which review card a message is, when it is one. Text messages are none of these. */
export function messageCard(message: Message): SearchCard | null {
  if (message.kind === 'goal.run' || message.goalRun) return 'goal';
  if (message.tool || message.kind === 'activity') return 'tool';
  if (message.kind === 'options' || message.kind === 'secret' || message.card?.requestId) return 'approval';
  return null;
}

function threadIdsFor(botId?: string, roomId?: string): Set<ThreadId> | null {
  if (!botId && !roomId) return null;
  const ids = new Set<ThreadId>();
  if (botId) {
    const bot = store.getBot(botId);
    if (bot) {
      ids.add(bot.threadId);
      for (const task of bot.tasks ?? []) ids.add(task.threadId);
    }
  }
  if (roomId) {
    const group = store.getGroup(roomId);
    if (group) {
      ids.add(group.threadId);
      for (const task of group.tasks ?? []) ids.add(task.threadId);
    }
  }
  return ids;
}

/** Text search, then bot, room, date, and card filters. A filter that matches nothing drops the hit. */
export function filterMessages(filter: SearchFilter): { threadId: ThreadId; message: Message }[] {
  const query = filter.query.trim();
  if (query.length < 2) return [];
  const threads = threadIdsFor(filter.botId, filter.roomId);
  const hits = store.search(query, 500);
  const matched = hits.filter((hit) => {
    if (threads && !threads.has(hit.threadId)) return false;
    if (filter.from != null && hit.message.at < filter.from) return false;
    if (filter.to != null && hit.message.at > filter.to) return false;
    if (filter.card && messageCard(hit.message) !== filter.card) return false;
    return true;
  });
  return matched.slice(0, filter.limit ?? 100);
}
