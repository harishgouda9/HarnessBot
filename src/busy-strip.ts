/**
 * Which bot the top strip should name. A bot that needs a person comes first.
 * Hidden bots stay off the strip. Idle bots are not "still working".
 */

export interface BusyBot {
  id: string;
  name: string;
  hidden?: boolean;
  activity?: string;
}

export interface BusyPick {
  id: string;
  name: string;
  activity: 'working' | 'waiting-on-you';
  /** Other live bots besides the one named on the strip. */
  extra: number;
}

export function pickBusyBot(bots: BusyBot[]): BusyPick | null {
  const live = bots.filter(
    (bot) => !bot.hidden && (bot.activity === 'working' || bot.activity === 'waiting-on-you'),
  );
  if (!live.length) return null;
  const bot = live.find((item) => item.activity === 'waiting-on-you') ?? live[0]!;
  return {
    id: bot.id,
    name: bot.name,
    activity: bot.activity === 'waiting-on-you' ? 'waiting-on-you' : 'working',
    extra: live.length - 1,
  };
}
