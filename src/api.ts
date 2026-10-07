/**
 * The app's only way to reach the harness: typed HTTP commands out, SSE in.
 * There are no agent transports in the renderer — that is the whole point of the
 * two-process split (HB-TRD-001 NFR-PERF-2).
 */

/** Leading slash, no trailing slash; empty stays empty. */
export const normalizeBase = (value: string): string => (value ? `/${value.replace(/^\/+|\/+$/g, '')}` : '');

/**
 * Where the harness answers. Empty for the standalone build, where the UI and the
 * harness share an origin. When Hermes serves this UI the two split apart: static
 * files come from the dashboard's unauthenticated plugin-asset route, and the API
 * is proxied through an authenticated one, so the API prefix cannot be derived
 * from Vite's BASE_URL and is baked separately.
 */
const API_BASE = normalizeBase(String(import.meta.env.VITE_HB_API_BASE ?? ''));

export const apiUrl = (path: string): string => `${API_BASE}${path}`;

/**
 * Hermes' dashboard authenticates two ways: a header on a loopback bind (the SPA
 * is handed a token) and a cookie once the auth gate is on. This UI runs in a
 * same-origin iframe, so the parent's token is readable; in gated mode there is no
 * token to find and the cookie travels on its own. Standalone, neither exists and
 * the harness wants no credentials at all.
 */
function sessionToken(): string | undefined {
  const read = (w: unknown): string | undefined =>
    (w as { __HERMES_SESSION_TOKEN__?: string } | undefined)?.__HERMES_SESSION_TOKEN__;
  try {
    return read(globalThis) ?? read((globalThis as { parent?: unknown }).parent);
  } catch {
    return undefined; // A cross-origin parent throws rather than answering.
  }
}

export function authHeaders(): Record<string, string> {
  const token = sessionToken();
  return token ? { 'X-Hermes-Session-Token': token } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const message = (parsed as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return parsed as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T,>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T,>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T,>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

/** Upload a file as an attachment and get back a URL the transcript can reference. */
export async function uploadAttachment(file: File): Promise<{ id: string; name: string; mime: string; url: string }> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return api.post('/api/attachments', { name: file.name, mime: file.type, data: btoa(binary) });
}

export async function speak(text: string, voice?: string): Promise<HTMLAudioElement> {
  const res = await fetch(apiUrl('/api/tts/speak'), {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) throw new Error(await res.text());
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  return audio;
}

/**
 * The SSE fold's transport: EventSource, but able to authenticate.
 *
 * `EventSource` cannot set a request header, and Hermes' dashboard requires one on
 * a loopback bind — which is the mode you land in when you reach a VPS the way
 * Hermes recommends, over an SSH tunnel. So the stream is read with `fetch`, which
 * can carry both the header and the cookie, and only the slice of the EventSource
 * surface the store actually uses is reimplemented here.
 */
export interface EventStream {
  addEventListener(name: string, handler: (event: { data: string }) => void): void;
  close(): void;
  /** Last SSE `id:` seen on this connection. Empty until a frame carries one. */
  lastEventId(): string;
}

export function streamEvents(path: string): EventStream {
  const listeners = new Map<string, ((event: { data: string }) => void)[]>();
  const controller = new AbortController();
  let closed = false;
  let lastId = '';

  const emit = (name: string, data: string): void => {
    for (const handler of listeners.get(name) ?? []) handler({ data });
  };

  // Started on a later tick than the caller, so the listeners registered
  // immediately after this returns are in place before anything is delivered.
  void (async () => {
    try {
      const res = await fetch(apiUrl(path), { headers: authHeaders(), signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`event stream refused: ${res.status}`);
      emit('open', '{}');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line. A partial tail stays buffered.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          let name = 'message';
          const data: string[] = [];
          for (const line of frame.split('\n')) {
            if (line.startsWith('id:')) lastId = line.slice(3).trim();
            else if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).trim());
            // ':' lines are comments — the keep-alive ping arrives as one.
          }
          if (data.length) emit(name, data.join('\n'));

          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!closed) emit('error', '{}');
    } catch {
      // A refused, dropped or aborted stream is the same signal to the store:
      // it reconnects on 'error' and stops once it has closed us.
      if (!closed) emit('error', '{}');
    }
  })();

  return {
    addEventListener: (name, handler) => {
      listeners.set(name, [...(listeners.get(name) ?? []), handler]);
    },
    close: () => {
      closed = true;
      controller.abort();
    },
    lastEventId: () => lastId,
  };
}
