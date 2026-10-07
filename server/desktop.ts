import type { BotRecord } from '../shared/types.ts';

export interface PackageStatus {
  platform: NodeJS.Platform;
  installer: 'unsigned' | 'signed';
  signed: boolean;
  updateSource: string | null;
  updateCheck: 'no-source' | 'configured';
}

/**
 * Honest packaging report. No certificate and no feed means unsigned and no
 * update source. This never reports a signature or an update that did not happen.
 */
export function packageStatus(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PackageStatus {
  const cert = String(env.CSC_LINK || env.WIN_CSC_LINK || '').trim();
  const feed = String(env.HB_UPDATE_FEED || '').trim();
  const signed = cert.length > 0;
  return {
    platform,
    installer: signed ? 'signed' : 'unsigned',
    signed,
    updateSource: feed || null,
    updateCheck: feed ? 'configured' : 'no-source',
  };
}

/** A secret card stores a value only when the user actually submitted one. */
export function explicitSecretValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loginItemSettings(enabled: boolean): { openAtLogin: boolean; openAsHidden: boolean } {
  return { openAtLogin: enabled, openAsHidden: enabled };
}

export type DesktopNotice = {
  botId: string;
  botName: string;
  threadId: string;
  taskTitle: string;
  preview: string;
};

/** Title and body a native notification shows. Clicking it opens this bot and task. */
export function nativeNotice(input: DesktopNotice): { title: string; body: string; botId: string; threadId: string } {
  return {
    title: `${input.botName} · ${input.taskTitle}`,
    body: input.preview,
    botId: input.botId,
    threadId: input.threadId,
  };
}

export function taskTitleFor(bot: Pick<BotRecord, 'threadId' | 'tasks'>, threadId: string): string {
  return bot.tasks?.find((task) => task.threadId === threadId)?.title?.trim() || (threadId === bot.threadId ? 'Main chat' : 'Task');
}
