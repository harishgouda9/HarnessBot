/**
 * Skill names are kebab-case, and both sides of the wire have to agree on that.
 *
 * The rule used to live only in the server, so the recorder let you type "Deploy
 * Staging", enabled its button, and then failed the POST. One regex, shared.
 */

export const MAX_SKILL_NAME = 64;
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length <= MAX_SKILL_NAME && SKILL_NAME_RE.test(trimmed);
}

/** Best effort: what the user typed, as a name the server will accept. */
export function slugifySkillName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME)
    .replace(/-+$/g, '');
}
