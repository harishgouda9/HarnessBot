import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamEvents } from './api.ts';

/**
 * The whole UI folds one event stream, and it is now parsed here rather than by the
 * browser's EventSource. Frame splitting, chunk boundaries and keep-alive comments
 * are therefore ours to get right.
 */

const encoder = new TextEncoder();

function bodyOf(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function mockFetch(chunks: string[]): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true, status: 200, body: bodyOf(chunks) } as unknown as Response);
  });
  return { calls };
}

/** Collect every frame the stream delivers, by event name. */
function collect(stream: ReturnType<typeof streamEvents>, names: string[]): [string, string][] {
  const seen: [string, string][] = [];
  for (const name of names) stream.addEventListener(name, (e) => seen.push([name, e.data]));
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamEvents', () => {
  it('parses named frames', async () => {
    mockFetch(['event: hello\ndata: {"clientId":"a"}\n\nevent: bot\ndata: {"id":"b1"}\n\n']);
    const stream = streamEvents('/api/events');
    const seen = collect(stream, ['hello', 'bot']);

    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toEqual(['hello', '{"clientId":"a"}']);
    expect(seen[1]).toEqual(['bot', '{"id":"b1"}']);
    stream.close();
  });

  it('reassembles a frame split across chunks', async () => {
    mockFetch(['event: bo', 't\ndata: {"id":', '"b1"}\n\n']);
    const stream = streamEvents('/api/events');
    const seen = collect(stream, ['bot']);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual(['bot', '{"id":"b1"}']);
    stream.close();
  });

  it('ignores keep-alive comments between frames', async () => {
    mockFetch([': ping\n\n', 'event: bot\ndata: {"id":"b1"}\n\n', ': ping\n\n']);
    const stream = streamEvents('/api/events');
    const seen = collect(stream, ['bot', 'message']);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]![0]).toBe('bot');
    stream.close();
  });

  it('signals error when the stream ends, so the store reconnects', async () => {
    mockFetch(['event: hello\ndata: {}\n\n']);
    const stream = streamEvents('/api/events');
    const seen = collect(stream, ['error']);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stream.close();
  });

  it('signals error when the dashboard refuses the stream', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 401, body: null } as unknown as Response));
    const stream = streamEvents('/api/events');
    const seen = collect(stream, ['error']);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stream.close();
  });

  it('sends the Hermes session header when the host exposes a token', async () => {
    vi.stubGlobal('__HERMES_SESSION_TOKEN__', 'tok-123');
    const { calls } = mockFetch(['event: hello\ndata: {}\n\n']);
    const stream = streamEvents('/api/events');

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect((calls[0]!.init.headers as Record<string, string>)['X-Hermes-Session-Token']).toBe('tok-123');
    stream.close();
  });

  it('records the last event id and requests the resume query it was given', async () => {
    const { calls } = mockFetch(['id: 7\nevent: bot\ndata: {"id":"b1"}\n\n']);
    const stream = streamEvents('/api/events?since=4&boot=boot-1');
    const seen = collect(stream, ['bot']);

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(stream.lastEventId()).toBe('7');
    expect(calls[0]!.url).toContain('/api/events?since=4&boot=boot-1');
    stream.close();
  });

  it('sends no session header when there is no token to find', async () => {
    const { calls } = mockFetch(['event: hello\ndata: {}\n\n']);
    const stream = streamEvents('/api/events');

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.init.headers).toEqual({});
    stream.close();
  });
});
