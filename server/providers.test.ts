import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLocalRuntimes } from './providers.ts';

/**
 * The local-model probe. A settings screen that reports "not running" for a runtime
 * that is running is worse than no screen at all, so these stand up real servers on
 * the ports the runtimes use and check the probe sees them.
 *
 * Each case takes a different runtime on purpose. `fetch` keeps its socket in a pool
 * keyed by host and port, so reusing one port across cases hands the next case a
 * connection to a server that has already been torn down — which reads exactly like
 * "not running" and makes the suite lie about the code.
 */

let server: http.Server | null = null;

function serveOn(port: number, handler: http.RequestListener): Promise<void> {
  return new Promise((resolve, reject) => {
    const created = http.createServer(handler);
    server = created;
    created.once('error', reject);
    created.listen(port, '127.0.0.1', () => resolve());
  });
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  server = null;
});

const find = async (id: string) => (await detectLocalRuntimes()).find((r) => r.id === id)!;

describe('local runtime detection', () => {
  it('reports every known runtime as absent when nothing is listening', async () => {
    const found = await detectLocalRuntimes();
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.running === false)).toBe(true);
    // A "not running" row still has to say how to start it, or it is a dead end.
    expect(found.every((r) => r.hint.length > 0)).toBe(true);
  });

  it('finds a runtime, lists what it holds, and sorts it to the top', async () => {
    await serveOn(11434, (req, res) => {
      res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'qwen2.5-coder' }] }));
    });

    const found = await detectLocalRuntimes();
    const ollama = found.find((r) => r.id === 'ollama')!;
    expect(ollama.running).toBe(true);
    expect(ollama.models).toEqual(['llama3.2', 'qwen2.5-coder']);
    expect(ollama.baseUrl).toBe('http://127.0.0.1:11434/v1');
    // The useful row should not sit below the dead ones.
    expect(found[0]!.id).toBe('ollama');
  });

  it('separates "up with no model" from "not running"', async () => {
    await serveOn(1234, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });

    const lmstudio = await find('lmstudio');
    // Collapsing these two into one boolean sends the user off to reinstall a server
    // that is already running and just has nothing loaded.
    expect(lmstudio.running).toBe(true);
    expect(lmstudio.models).toEqual([]);
    expect(lmstudio.reason).toMatch(/no model/i);
  });

  it('does not treat an error response as a working runtime', async () => {
    await serveOn(8080, (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });

    const llamacpp = await find('llamacpp');
    expect(llamacpp.running).toBe(false);
    expect(llamacpp.reason).toContain('500');
  });

  it('survives a runtime that answers with nonsense', async () => {
    await serveOn(8000, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json at all');
    });

    expect((await find('vllm')).running).toBe(false);
  });
});

describe('a loopback endpoint needs no key', () => {
  const ctx = (secrets: Record<string, string> = {}) => ({
    instanceId: 'test',
    displayName: 'Test',
    emit: () => {},
    secret: (name: string) => secrets[name],
    dataDir: '',
  });

  it('is available on localhost with no credential at all', async () => {
    const { openAiCompatDriver } = await import('./drivers/openai-compat.ts');
    const adapter = await openAiCompatDriver.create(
      openAiCompatDriver.decodeConfig({ baseUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'llama3.2' }] }),
      ctx() as never,
    );
    // Demanding a key here made "run a model locally" impossible: there is no key to give.
    expect((await adapter.snapshot()).state).toBe('available');
  });

  it('still demands one for a remote endpoint', async () => {
    const { openAiCompatDriver } = await import('./drivers/openai-compat.ts');
    const adapter = await openAiCompatDriver.create(
      openAiCompatDriver.decodeConfig({ baseUrl: 'https://openrouter.ai/api/v1', models: [{ id: 'm' }] }),
      ctx() as never,
    );
    const snap = await adapter.snapshot();
    expect(snap.state).toBe('unavailable');
    expect(snap.reason).toMatch(/API key/i);
  });
});
