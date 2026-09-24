import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveConfig } from './config.ts';
import * as connectors from './connectors.ts';

/**
 * The bug this file exists for: v3's POST /connected_accounts answered every Connect
 * click with "Validation error while processing request". The shape of the two calls
 * authorize now makes is the whole fix, so the test asserts on the bodies.
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;

function mockComposio(responses: Record<string, unknown>): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const value = key ? responses[key] : {};
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  saveConfig({ secrets: { 'composio.apiKey': 'test-key' } });
  for (const account of connectors.listConnected()) connectors.disconnect(account.id);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('composio connect', () => {
  it('reuses an existing auth config and opens a link session', async () => {
    mockComposio({
      '/auth_configs?': { items: [{ id: 'ac_existing' }] },
      '/connected_accounts/link': { connected_account_id: 'ca_1', redirect_url: 'https://composio.dev/oauth' },
    });

    const result = await connectors.authorize('gmail');

    expect(result.redirectUrl).toBe('https://composio.dev/oauth');
    // No POST to /auth_configs: the existing one was reused.
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/auth_configs'))).toHaveLength(0);

    const link = calls.find((c) => c.url.includes('/connected_accounts/link'))!;
    expect(link.method).toBe('POST');
    expect(link.body).toEqual({ auth_config_id: 'ac_existing', user_id: 'default' });
    // The retired v3 shape must never be sent again.
    expect(link.body).not.toHaveProperty('auth_scheme');
    expect(link.url).toContain('/api/v3.1/');
  });

  it('creates a composio-managed auth config when the toolkit has none', async () => {
    mockComposio({
      '/auth_configs?': { items: [] },
      '/auth_configs': { auth_config: { id: 'ac_new' } },
      '/connected_accounts/link': { connected_account_id: 'ca_2', redirect_url: 'https://composio.dev/oauth' },
    });

    await connectors.authorize('slack');

    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/auth_configs'))!;
    expect(created.body).toEqual({ toolkit: { slug: 'slack' }, auth_config: { type: 'use_composio_managed_auth' } });
  });

  it('holds a new account at pending until composio reports it active', async () => {
    mockComposio({
      '/auth_configs?': { items: [{ id: 'ac_existing' }] },
      '/connected_accounts/link': { connected_account_id: 'ca_3', redirect_url: 'https://composio.dev/oauth' },
    });
    await connectors.authorize('notion');

    // An abandoned OAuth tab is not a connection.
    expect(connectors.isConnected('notion')).toBe(false);

    mockComposio({ '/connected_accounts/ca_3': { status: 'ACTIVE' } });
    await connectors.refreshStatuses();
    expect(connectors.isConnected('notion')).toBe(true);
  });

  it('surfaces the composio message rather than a raw json blob', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Validation error while processing request' } }), {
        status: 400,
      })) as typeof fetch;

    await expect(connectors.authorize('github')).rejects.toThrow(/Validation error while processing request/);
  });
});
