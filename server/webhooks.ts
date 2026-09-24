import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { newId } from './paths.ts';
import { getRoutine, loadWebhooks, runRoutine, saveWebhooks } from './routines.ts';

/**
 * The webhook receiver runs on its own port and serves exactly two routes:
 * GET /health and POST /hooks/:secret. It shares a process with the harness but not
 * a listener, because this is the only port anyone is told they may tunnel to the
 * internet — and the harness API has no authentication at all (NFR-SEC-5).
 */

const RATE_LIMIT = { windowMs: 60_000, max: 10 };
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PENDING_RUNS = 3;

const acceptedHits: number[] = [];
const failedHits: number[] = [];
let pendingRuns = 0;

const hash = (secret: string): string => createHash('sha256').update(secret).digest('hex');

function secretMatches(presented: string, storedHash: string): boolean {
  const a = Buffer.from(hash(presented));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createWebhook(name: string, routineId: string): { record: ReturnType<typeof loadWebhooks>['webhooks'][number]; secret: string } {
  const file = loadWebhooks();
  // Shown once, then only the hash is kept. There is no "reveal" endpoint.
  const secret = `wh_${randomBytes(24).toString('base64url')}`;
  const record = { id: newId('wh'), name, routineId, secretHash: hash(secret), createdAt: Date.now() };
  file.webhooks.push(record);
  saveWebhooks(file);
  return { record, secret };
}

export function rotateWebhook(id: string): string | null {
  const file = loadWebhooks();
  const record = file.webhooks.find((w) => w.id === id);
  if (!record) return null;
  const secret = `wh_${randomBytes(24).toString('base64url')}`;
  record.secretHash = hash(secret);
  saveWebhooks(file);
  return secret;
}

export function deleteWebhook(id: string): void {
  const file = loadWebhooks();
  file.webhooks = file.webhooks.filter((w) => w.id !== id);
  saveWebhooks(file);
}

export function listWebhooks() {
  const file = loadWebhooks();
  // secretHash never leaves the process. The last delivery does: a hook that has never
  // fired and a hook that fired an hour ago need different debugging.
  return file.webhooks.map(({ secretHash: _h, ...rest }) => ({
    ...rest,
    lastDeliveryAt: file.deliveries.filter((d) => d.webhookId === rest.id).at(-1)?.at,
  }));
}

/** True when this bucket is already full. Failures and accepted deliveries do not share one. */
function hitLimit(bucket: number[], max: number): boolean {
  const now = Date.now();
  while (bucket.length && now - bucket[0]! > RATE_LIMIT.windowMs) bucket.shift();
  if (bucket.length >= max) return true;
  bucket.push(now);
  return false;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const seenDeliveries = new Map<string, number>();

function duplicateDelivery(id: string): boolean {
  const now = Date.now();
  for (const [key, at] of seenDeliveries) if (now - at > 24 * 3600_000) seenDeliveries.delete(key);
  if (seenDeliveries.has(id)) return true;
  seenDeliveries.set(id, now);
  return false;
}

export function startWebhookServer(port = Number(process.env.HB_WEBHOOK_PORT ?? Number(process.env.HB_PORT ?? 8799) + 1)) {
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      send(400, { error: 'bad request' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, { app: 'harnessbot-webhooks', ready: true });
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/hooks/')) {
      // Everything else 404s. There is deliberately no route to the harness API here.
      send(404, { error: 'not found' });
      return;
    }

    void (async () => {
      const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      // Bearer is preferred; the URL secret exists only for senders that cannot set headers.
      let fromUrl = '';
      try {
        fromUrl = decodeURIComponent(url.pathname.slice('/hooks/'.length));
      } catch {
        send(400, { error: 'bad request' });
        return;
      }
      const presented = bearer || fromUrl;
      const file = loadWebhooks();
      const record = file.webhooks.find((w) => secretMatches(presented, w.secretHash));
      if (!record) {
        // A scanner must not be able to spend the budget that real deliveries use.
        if (hitLimit(failedHits, RATE_LIMIT.max)) {
          send(429, { error: 'rate limited' });
          return;
        }
        send(404, { error: 'not found' });
        return;
      }
      if (hitLimit(acceptedHits, RATE_LIMIT.max)) {
        send(429, { error: 'rate limited' });
        return;
      }

      let body = '';
      try {
        body = await readBody(req);
      } catch {
        send(413, { error: 'body too large' });
        return;
      }

      const deliveryId =
        (req.headers['idempotency-key'] as string) ??
        (req.headers['x-webhook-id'] as string) ??
        (req.headers['x-github-delivery'] as string) ??
        (req.headers['webhook-id'] as string) ??
        newId('dlv');

      if (duplicateDelivery(deliveryId)) {
        send(202, { accepted: true, duplicate: true, deliveryId });
        return;
      }

      const routine = getRoutine(record.routineId);
      if (!routine) {
        send(202, { accepted: false, ignored: 'routine missing', deliveryId });
        return;
      }
      if (pendingRuns >= MAX_PENDING_RUNS) {
        send(429, { accepted: false, ignored: 'too many pending runs', deliveryId });
        return;
      }

      record.lastDeliveryAt = Date.now();
      file.deliveries.push({ id: deliveryId, webhookId: record.id, at: Date.now() });
      saveWebhooks(file);

      pendingRuns++;
      const runPromise = runRoutine(routine, { triggerSource: 'webhook', webhookId: record.id, deliveryId }).finally(() => {
        pendingRuns--;
      });
      const run = await runPromise.catch(() => null);

      send(202, {
        accepted: true,
        runId: run?.id,
        deliveryId,
        duplicate: false,
        captured: body.length > 0 ? body.length : undefined,
      });
    })().catch(() => {
      if (!res.headersSent) send(500, { error: 'internal error' });
    });
  });

  server.listen(port, '127.0.0.1');
  return server;
}
