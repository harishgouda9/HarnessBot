import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * /api/internal/* is how a bot's own MCP proxies call back into the harness
 * (ask_bot, memory, connectors, computer-control). The harness has no user auth
 * because it is loopback-only, but these routes are reachable by any local process,
 * so each bot gets a random bearer minted at boot and dropped when the bot is deleted.
 *
 * Regenerating per process start means a token that leaked into a log yesterday is
 * useless today.
 */

const tokens = new Map<string, string>();

export function mintInternalToken(botId: string): string {
  const existing = tokens.get(botId);
  if (existing) return existing;
  const token = randomBytes(32).toString('base64url');
  tokens.set(botId, token);
  return token;
}

export function revokeInternalToken(botId: string): void {
  tokens.delete(botId);
}

export function verifyInternalToken(botId: string, presented: string | undefined): boolean {
  const expected = tokens.get(botId);
  if (!expected || !presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function botForToken(presented: string | undefined): string | null {
  if (!presented) return null;
  for (const [botId] of tokens) {
    if (verifyInternalToken(botId, presented)) return botId;
  }
  return null;
}

/** Env handed to a spawned proxy. Tokens go through env, never argv — `ps` is public. */
export function internalMountEnv(botId: string): Record<string, string> {
  return {
    HB_INTERNAL_TOKEN: mintInternalToken(botId),
    HB_INTERNAL_BOT: botId,
    HB_INTERNAL_URL: `http://127.0.0.1:${process.env.HB_PORT ?? 8799}`,
  };
}
