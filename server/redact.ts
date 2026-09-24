/**
 * Scrub content-shaped secrets from anything the *bot* authored before it is stored
 * (HB-PRD-001 F-SEC-04). User-typed text is left exactly as typed — the user is the
 * trust boundary here, and silently rewriting what they wrote would be worse.
 */

const PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, label: 'anthropic-key' },
  { re: /\bsk-[A-Za-z0-9]{32,}/g, label: 'openai-key' },
  { re: /\bxai-[A-Za-z0-9]{16,}/g, label: 'xai-key' },
  { re: /\b(?:ak|ck)_[A-Za-z0-9_-]{16,}/g, label: 'composio-key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, label: 'github-token' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, label: 'slack-token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key-id' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: 'jwt' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'private-key' },
  // Assignment shapes: TOKEN=..., "apiKey": "...".
  { re: /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"',;]{12,})/gi, label: 'assignment' },
];

export const REDACTED = '[redacted]';

export function redactSecretsInText(text: string): string;
export function redactSecretsInText(text: undefined): undefined;
export function redactSecretsInText(text: string | undefined): string | undefined;
export function redactSecretsInText(text: string | undefined): string | undefined {
  if (!text) return text;
  let out = text;
  for (const { re, label } of PATTERNS) {
    re.lastIndex = 0;
    out =
      label === 'assignment'
        ? out.replace(re, (_m, name: string) => `${name}=${REDACTED}`)
        : out.replace(re, REDACTED);
  }
  return out;
}

/** Deep-redact every string in a bot-authored payload (tool titles, card fields, run output). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecretsInText(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

