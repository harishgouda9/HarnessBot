/**
 * Ceilings for the system prompt.
 *
 * The system prompt is rebuilt for every turn and most drivers send it every time,
 * so anything unbounded in it is not paid once — it is paid per turn, forever. Four
 * sections had no ceiling at all: a bot's description, its playbooks, a room
 * bulletin, and the skill list. The last one stopped being theoretical when the
 * Hermes bridge made a 62-skill library installable in one click.
 *
 * These are ceilings, not compression. Nothing here rewrites what the user wrote;
 * it truncates at a stated point and says so, so a bot reading its own prompt can
 * tell the difference between "you were told nothing" and "you were told more than
 * fits".
 */

/** Sections are ordered stable-first in `systemPrompt` so a provider's prompt cache
 *  keeps hitting: memory changes most often, so it goes last. */
export const PROMPT_LIMITS = {
  description: 1200,
  playbookCount: 12,
  playbookInstructions: 600,
  skillCount: 40,
  skillSummary: 160,
  bulletin: 1200,
  transcriptKeep: 40,
} as const;

/**
 * Lean ceilings. Same sections, tighter numbers. The opening request still survives
 * in the transcript digest — this is compression of the *repeating* tax, not amnesia.
 */
export const LEAN_LIMITS = {
  description: 400,
  playbookCount: 3,
  playbookInstructions: 180,
  skillCount: 8,
  skillSummary: 80,
  bulletin: 400,
  transcriptKeep: 12,
} as const;

export type PromptLimits = typeof PROMPT_LIMITS | typeof LEAN_LIMITS;

export function limitsFor(lean: boolean): PromptLimits {
  return lean ? LEAN_LIMITS : PROMPT_LIMITS;
}

/** Rough tokens: four characters to a token is the usual cheap estimate. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Keep items whose text overlaps the query, falling back to recency (original order)
 * when nothing matches. Always reports how many were left out.
 */
export function pickRelevant<T>(
  items: readonly T[],
  query: string,
  textOf: (item: T) => string,
  max: number,
): { kept: T[]; hidden: number } {
  if (items.length <= max) return { kept: [...items], hidden: 0 };
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (!terms.length) return clipList(items, max);

  const scored = items.map((item, index) => {
    const hay = textOf(item).toLowerCase();
    let score = 0;
    for (const term of terms) if (hay.includes(term)) score += 1;
    return { item, score, index };
  });
  const matched = scored.filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const pool = matched.length ? matched : scored;
  const kept = pool.slice(0, max).map((row) => row.item);
  return { kept, hidden: items.length - kept.length };
}

const SMALL_MODEL = /haiku|mini|fast|flash|lite|nano|tiny|small|8b|7b|3\.5|low/i;

/**
 * A short ask that should not pay for a full agent toolkit.
 *
 * Hands, browsing, and "do this in the repo" still take the slow path. Everything
 * else — a greeting, a fact, a one-line rewrite — should answer on the fast model
 * with no MCP servers attached.
 */
export function isQuickTurn(text: string, extra?: { attachments?: unknown[]; context?: string }): boolean {
  if (extra?.attachments && extra.attachments.length > 0) return false;
  if (extra?.context?.trim()) return false;
  const value = String(text ?? '').trim();
  if (!value || value.length > 240) return false;
  if ((value.match(/\n/g) ?? []).length > 2) return false;
  if (
    /\b(implement|refactor|deploy|screenshot|click |open the |browse|search the web|install |debug this|write a (pr|patch|test)|computer|desktop|mouse|keyboard|browser|chrome|firefox|edge)\b|\btake (over|control)\b/i.test(
      value,
    )
  ) {
    return false;
  }
  return true;
}

/** Provider slug of a Hermes `provider:model` id. A plain id has no provider. */
function modelProviderId(id: string): string {
  const cut = id.indexOf(':');
  return cut > 0 ? id.slice(0, cut).toLowerCase() : '';
}

/**
 * A cheaper sibling on the same provider, or null if this already is one.
 *
 * Hermes lists every signed-in provider in one catalogue. The first Haiku or Mini
 * in that list is often a different vendor. A short message must not be moved
 * onto it: the header would keep the model the user pinned, and the reply would
 * come from the other account.
 */
export function pickSmallerModel(models: { id: string; label: string }[], current: string): string | null {
  if (!models.length || !current) return null;
  if (SMALL_MODEL.test(current)) return null;
  const provider = modelProviderId(current);
  const found = models.find((m) => {
    if (m.id === current) return false;
    if (modelProviderId(m.id) !== provider) return false;
    return SMALL_MODEL.test(`${m.id} ${m.label}`);
  });
  return found?.id ?? null;
}

/**
 * The model id a turn should send.
 *
 * The pinned id is the one the picker shows. A smaller sibling is used only when
 * the user turned on "Prefer a smaller model for short messages", and only on
 * the same provider. `default` leaves the agent on its own config.
 */
export function resolveTurnModel(
  selected: string,
  models: { id: string; label: string }[],
  preferSmall: boolean,
): string {
  if (!preferSmall || !selected || selected === 'default') return selected;
  return pickSmallerModel(models, selected) ?? selected;
}

/** Truncate on a word boundary where one is near, and say that it happened. */
export function clip(text: string, max: number): string {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(' ');
  const body = space > max * 0.8 ? cut.slice(0, space) : cut;
  return `${body.trimEnd()}… (truncated)`;
}

/** Keep the first `max` items and report how many were left out. */
export function clipList<T>(items: readonly T[], max: number): { kept: T[]; hidden: number } {
  if (items.length <= max) return { kept: [...items], hidden: 0 };
  return { kept: items.slice(0, max), hidden: items.length - max };
}
