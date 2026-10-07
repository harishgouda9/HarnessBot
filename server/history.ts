import type { HistoryEntry } from '../shared/types.ts';
import { ensureHydrated, latestPerThread, searchMessages } from './message-db.ts';
import { redactSecretsInText } from './redact.ts';
import { store } from './store.ts';

/**
 * Past conversations, read from the threads the roster already has.
 * There is no second transcript store.
 */

interface Owner {
  title: string;
  botId?: string;
  botName?: string;
  groupId?: string;
  kind: HistoryEntry['kind'];
  at: number;
}

function preview(text: string | null | undefined): string {
  return redactSecretsInText(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function owners(): Map<string, Owner> {
  const map = new Map<string, Owner>();
  for (const bot of store.listBots()) {
    if (bot.hidden) continue;
    const tasks = bot.tasks?.length
      ? bot.tasks
      : [{ threadId: bot.threadId, title: 'Chat', createdAt: bot.createdAt }];
    for (const task of tasks) {
      ensureHydrated(task.threadId);
      map.set(task.threadId, {
        title: task.title || 'Chat',
        botId: bot.id,
        botName: bot.name,
        kind: tasks.length > 1 ? 'task' : 'chat',
        at: task.createdAt,
      });
    }
  }
  for (const group of store.listGroups()) {
    const tasks = group.tasks?.length
      ? group.tasks
      : [{ threadId: group.threadId, title: group.name, createdAt: 0 }];
    for (const task of tasks) {
      ensureHydrated(task.threadId);
      map.set(task.threadId, {
        title: task.title || group.name,
        groupId: group.id,
        kind: 'room',
        at: task.createdAt,
      });
    }
    if (!map.has(group.threadId)) {
      ensureHydrated(group.threadId);
      map.set(group.threadId, { title: group.name, groupId: group.id, kind: 'room', at: 0 });
    }
  }
  return map;
}

function entry(threadId: string, owner: Owner | undefined, text: string | null | undefined, at: number): HistoryEntry {
  return {
    threadId,
    title: owner?.title ?? 'Chat',
    botId: owner?.botId,
    botName: owner?.botName,
    groupId: owner?.groupId,
    preview: preview(text),
    at: at || owner?.at || 0,
    kind: owner?.kind ?? 'chat',
  };
}

export function listHistory(query = ''): HistoryEntry[] {
  const known = owners();
  const q = query.trim();
  if (q) {
    const seen = new Set<string>();
    const hits: HistoryEntry[] = [];
    for (const hit of searchMessages(q, 80)) {
      if (seen.has(hit.threadId)) continue;
      seen.add(hit.threadId);
      hits.push(entry(hit.threadId, known.get(hit.threadId), hit.message.text, hit.message.at));
      if (hits.length >= 40) break;
    }
    return hits;
  }

  const latest = new Map(latestPerThread(300).map((row) => [row.threadId, row]));
  const rows: HistoryEntry[] = [];
  for (const [threadId, owner] of known) {
    const row = latest.get(threadId);
    rows.push(entry(threadId, owner, row?.text, row?.at ?? owner.at));
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.slice(0, 200);
}
