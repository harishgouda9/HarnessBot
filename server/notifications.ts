import { EventEmitter } from 'node:events';
import type { BotRecord } from '../shared/types.ts';

/**
 * Explicit proactivity only (HB-PRD-001 F-NOTIF-01). There is no heartbeat and no
 * "checking in" — a notification exists because a turn produced something that needs
 * the user, and it always points at the exact bot and task that produced it.
 */

export type NotificationKind = 'needs-approval' | 'needs-hands' | 'finished' | 'failed';

export interface Notification {
  id: string;
  botId: string;
  botName: string;
  threadId: string;
  kind: NotificationKind;
  preview: string;
  at: number;
}

class Notifications extends EventEmitter {
  private recent: Notification[] = [];

  push(bot: BotRecord, input: { kind: NotificationKind; threadId: string; preview: string }): void {
    // Per-bot switch. A chatty bot should not be able to turn itself back on.
    if (bot.notifications === false) return;
    // "finished" only counts when there is actually something to read.
    if (input.kind === 'finished' && !input.preview.trim()) return;

    const notification: Notification = {
      id: `${bot.id}:${Date.now()}`,
      botId: bot.id,
      botName: bot.name,
      threadId: input.threadId,
      kind: input.kind,
      preview: input.preview,
      at: Date.now(),
    };
    this.recent = [notification, ...this.recent].slice(0, 100);
    this.emit('notify', notification);
  }

  list(): Notification[] {
    return this.recent;
  }
}

export const notifications = new Notifications();

export function notify(bot: BotRecord, input: { kind: NotificationKind; threadId: string; preview: string }): void {
  notifications.push(bot, input);
}
