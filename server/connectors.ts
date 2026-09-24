import type { ConnectorCardData } from '../shared/types.ts';
import { getSecret } from './config.ts';
import { dataPath, readJsonSafe, writeJsonAtomic } from './paths.ts';
import { store } from './store.ts';

/**
 * Connected apps over Composio. OAuth stays with Composio; HarnessBot only ever
 * holds a project key and a list of which toolkits are connected. When a turn needs
 * an app that is not connected, that becomes a card in the thread rather than a
 * silent tool failure (HB-PRD-001 F-APP-02).
 */

/**
 * v3 froze and its POST /connected_accounts started rejecting Composio-managed OAuth
 * outright, which is the "Validation error while processing request" every Connect
 * button used to end in. The live flow is: find or create an auth config for the
 * toolkit, then open a link session against it.
 */
const API = 'https://backend.composio.dev/api/v3.1';
/** Composio scopes connections to a user id. One local machine is one user. */
const USER_ID = 'default';
const CONNECTED_FILE = dataPath('connected-apps.json');
const MAX_ACCOUNTS_PER_TOOLKIT = 5;

/**
 * `pending` is the honest state right after authorize: the browser tab is open and
 * nobody has finished OAuth yet. Calling that "connected" is what made a cancelled
 * login look like a working Gmail.
 */
export type AccountStatus = 'pending' | 'active' | 'failed';

export interface ConnectedAccount {
  id: string;
  slug: string;
  label: string;
  connectedAt: number;
  status?: AccountStatus;
}

interface ConnectedFile {
  version: 1;
  accounts: ConnectedAccount[];
}

const load = (): ConnectedFile => readJsonSafe<ConnectedFile>(CONNECTED_FILE, { version: 1, accounts: [] });
const save = (file: ConnectedFile): void => writeJsonAtomic(CONNECTED_FILE, file);

export function composioConfigured(): boolean {
  return Boolean(getSecret('composio.apiKey'));
}

/** Composio wraps its failures in {error:{message}}; a raw blob in a banner helps nobody. */
function detail(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const err = json.error;
    const message = typeof err === 'string' ? err : (err?.message ?? json.message);
    if (message) return String(message).slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}

async function composio<T>(key: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-api-key': key, 'content-type': 'application/json', ...init?.headers },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Composio ${res.status}: ${detail(text)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * One Composio-managed auth config per toolkit, reused. Creating a second one for
 * every Connect click is how an account ends up with forty identical Gmail configs.
 */
async function authConfigFor(key: string, slug: string): Promise<string> {
  const found = await composio<{ items?: { id: string }[] }>(
    key,
    `/auth_configs?toolkit_slug=${encodeURIComponent(slug)}&is_composio_managed=true&limit=1`,
  );
  const existing = found.items?.[0]?.id;
  if (existing) return existing;

  const created = await composio<{ auth_config?: { id?: string } }>(key, '/auth_configs', {
    method: 'POST',
    body: JSON.stringify({ toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth' } }),
  });
  const id = created.auth_config?.id;
  if (!id) throw new Error(`Composio returned no auth config for ${slug}`);
  return id;
}

export interface Toolkit {
  slug: string;
  name: string;
  logo?: string;
  categories?: string[];
}

/** A small offline catalog so the marketplace is browsable before a key is pasted. */
const FALLBACK_CATALOG: Toolkit[] = [
  { slug: 'gmail', name: 'Gmail', categories: ['email'] },
  { slug: 'slack', name: 'Slack', categories: ['chat'] },
  { slug: 'github', name: 'GitHub', categories: ['dev'] },
  { slug: 'notion', name: 'Notion', categories: ['docs'] },
  { slug: 'linear', name: 'Linear', categories: ['issues'] },
  { slug: 'googlecalendar', name: 'Google Calendar', categories: ['calendar'] },
  { slug: 'googledrive', name: 'Google Drive', categories: ['files'] },
  { slug: 'jira', name: 'Jira', categories: ['issues'] },
];

export async function catalog(query?: string): Promise<Toolkit[]> {
  const key = getSecret('composio.apiKey');
  if (!key) return filterCatalog(FALLBACK_CATALOG, query);
  try {
    const json = await composio<{ items?: { slug: string; name: string; meta?: { logo?: string } }[] }>(key, '/toolkits?limit=200');
    const items = (json.items ?? []).map((t) => ({ slug: t.slug, name: t.name, logo: t.meta?.logo }));
    return filterCatalog(items.length ? items : FALLBACK_CATALOG, query);
  } catch {
    // Offline or rate-limited: show the fallback rather than an empty marketplace.
    return filterCatalog(FALLBACK_CATALOG, query);
  }
}

function filterCatalog(items: Toolkit[], query?: string): Toolkit[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((t) => t.slug.includes(q) || t.name.toLowerCase().includes(q));
}

export function listConnected(): ConnectedAccount[] {
  return load().accounts;
}

export function isConnected(slug: string): boolean {
  return load().accounts.some((a) => a.slug === slug && a.status !== 'pending' && a.status !== 'failed');
}

/**
 * Begin an OAuth connection. The user completes it in their browser at Composio;
 * we only learn the outcome, never the credentials.
 */
export async function authorize(slug: string, label?: string): Promise<{ redirectUrl?: string; accountId: string }> {
  const key = getSecret('composio.apiKey');
  if (!key) throw new Error('Add a Composio key in Settings -> Keys first');
  const file = load();
  if (file.accounts.filter((a) => a.slug === slug).length >= MAX_ACCOUNTS_PER_TOOLKIT) {
    throw new Error(`At most ${MAX_ACCOUNTS_PER_TOOLKIT} accounts per app`);
  }

  const authConfigId = await authConfigFor(key, slug);
  const link = await composio<{ redirect_url?: string; connected_account_id?: string; link_token?: string }>(
    key,
    '/connected_accounts/link',
    { method: 'POST', body: JSON.stringify({ auth_config_id: authConfigId, user_id: USER_ID }) },
  );

  const accountId = link.connected_account_id ?? `acct_${Date.now()}`;
  // Recorded as pending. It only becomes `active` once Composio says the user finished.
  file.accounts.push({ id: accountId, slug, label: label ?? slug, connectedAt: Date.now(), status: 'pending' });
  save(file);
  return { redirectUrl: link.redirect_url, accountId };
}

/**
 * Reconcile pending accounts with Composio. Bounded by MAX_ACCOUNTS_PER_TOOLKIT and
 * only ever touches accounts that have not settled, so listing stays cheap.
 */
export async function refreshStatuses(): Promise<ConnectedAccount[]> {
  const key = getSecret('composio.apiKey');
  const file = load();
  const pending = file.accounts.filter((a) => (a.status ?? 'active') === 'pending');
  if (!key || !pending.length) return file.accounts;

  await Promise.all(
    pending.map(async (account) => {
      try {
        const remote = await composio<{ status?: string }>(key, `/connected_accounts/${encodeURIComponent(account.id)}`);
        const status = String(remote.status ?? '').toUpperCase();
        if (status === 'ACTIVE') account.status = 'active';
        else if (status === 'FAILED' || status === 'EXPIRED' || status === 'INACTIVE') account.status = 'failed';
      } catch {
        // Offline or a transient 5xx: leave it pending rather than declaring failure.
      }
    }),
  );
  save(file);
  return file.accounts;
}

export function disconnect(accountId: string): void {
  const file = load();
  file.accounts = file.accounts.filter((a) => a.id !== accountId);
  save(file);
}

/**
 * Raise a connector card in a bot's thread. Cards sharing a resumeKey belong to one
 * request and resume together once the last one connects.
 */
export function requestConnection(botId: string, slug: string, reason: string, resumeKey: string): ConnectorCardData | null {
  const bot = store.getBot(botId);
  if (!bot) return null;
  // A bot with connected apps switched off does not get to ask for them.
  if (bot.composio === false) return null;

  const card: ConnectorCardData = {
    slug,
    label: slug,
    status: isConnected(slug) ? 'connected' : 'required',
    resumeKey,
    reason,
  };
  store.appendMessage(bot.threadId, { role: 'bot', kind: 'connector', connector: card });
  return card;
}
