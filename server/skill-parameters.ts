/**
 * Turn a recorded demonstration into a reusable one.
 *
 * A recording is made once, against one customer, one date, one inbox — and then
 * it is worth running against the next. Left alone it hardcodes whatever the user
 * happened to type, so the same literal is lifted into a `{{placeholder}}` and
 * listed once at the top, which is the difference between a transcript and a
 * procedure.
 *
 * Deliberately conservative. It only lifts values whose *shape* says they are an
 * input — an address, a link, a date, something the user put in quotes — and the
 * same literal always becomes the same placeholder, because a value that recurs
 * across steps is the strongest evidence available that it is a parameter. The
 * names are typed rather than clever (`{{email}}`, `{{value_2}}`): guessing that
 * `"Acme Corp"` means `{{client_name}}` is exactly the sort of guess that reads
 * well in a demo and is wrong in practice. The staged skill is reviewed before it
 * installs, and renaming a placeholder there is the user's job.
 */

export interface SkillParameter {
  name: string;
  example: string;
}

export interface Parameterised {
  steps: string[];
  parameters: SkillParameter[];
}

/** At some point a step made entirely of placeholders is less readable, not more. */
const MAX_PARAMETERS = 12;

/**
 * Order matters: the specific shapes run first, and the quoted rule then skips
 * anything already templated so `"{{email}}"` is not lifted a second time.
 */
const RULES: { kind: string; pattern: RegExp; inner?: boolean }[] = [
  { kind: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { kind: 'url', pattern: /https?:\/\/[^\s"'<>)\]]+/g },
  { kind: 'date', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  // Quotes are the user saying "this bit is data" without being asked to.
  { kind: 'value', pattern: /"([^"\n]{1,80})"|'([^'\n]{1,80})'/g, inner: true },
];

export function parameterise(steps: readonly string[]): Parameterised {
  const parameters: SkillParameter[] = [];
  const assigned = new Map<string, string>();
  const usedPerKind = new Map<string, number>();

  const placeholderFor = (kind: string, literal: string): string | null => {
    const key = `${kind}:${literal}`;
    const existing = assigned.get(key);
    if (existing) return existing;
    if (parameters.length >= MAX_PARAMETERS) return null;

    const seen = (usedPerKind.get(kind) ?? 0) + 1;
    usedPerKind.set(kind, seen);
    const name = seen === 1 ? kind : `${kind}_${seen}`;
    assigned.set(key, name);
    parameters.push({ name, example: literal });
    return name;
  };

  const rewritten = steps.map((step) => {
    let text = step;
    for (const rule of RULES) {
      text = text.replace(new RegExp(rule.pattern.source, rule.pattern.flags), (match, ...groups) => {
        const literal = rule.inner ? (groups.find((g) => typeof g === 'string') as string | undefined) : match;
        if (literal === undefined) return match;
        // Already a placeholder, or a fragment of one: leave it alone.
        if (literal.includes('{{') || !literal.trim()) return match;

        const name = placeholderFor(rule.kind, literal);
        if (!name) return match;
        return rule.inner ? match.replace(literal, `{{${name}}}`) : `{{${name}}}`;
      });
    }
    return text;
  });

  return { steps: rewritten, parameters };
}

/** The `## Parameters` block, or nothing when the recording had no inputs to lift. */
export function renderParameters(parameters: readonly SkillParameter[]): string[] {
  if (!parameters.length) return [];
  return [
    '',
    '## Parameters',
    '',
    'Supply these when running the skill. Rename any that would read better with a',
    'clearer name — the examples are what was recorded.',
    '',
    ...parameters.map((p) => `- \`{{${p.name}}}\` — e.g. ${p.example}`),
  ];
}
