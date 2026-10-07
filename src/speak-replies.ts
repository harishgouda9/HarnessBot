import type { BotRecord, Message } from '../shared/types.ts';

/**
 * A finished bot reply that should be spoken. History loaded over HTTP is not passed
 * here — only a message that just arrived — so opening a thread does not read it aloud.
 */
export function replyToSpeak(
  bots: BotRecord[],
  fallbackVoice: string | undefined,
  threadId: string,
  message: Message,
  arrivedAfter = 0,
): { text: string; voice: string } | null {
  // A reconnect replays recent SSE frames. Those messages are older than this connection.
  if ((message.at ?? 0) < arrivedAfter) return null;
  if (message.role !== 'bot' || message.kind !== 'text') return null;
  const text = message.text?.trim();
  if (!text) return null;
  const bot = bots.find(
    (candidate) =>
      candidate.speakReplies === true &&
      (candidate.threadId === threadId || candidate.tasks?.some((task) => task.threadId === threadId)),
  );
  if (!bot) return null;
  const voice = bot.voice || fallbackVoice;
  if (!voice) return null;
  return { text, voice };
}
