import type { BotRecord, DecisionLogEntry, OptionCardData, ThreadId } from '../shared/types.ts';
import type { RequestOutcome, RequestSource, RuntimeEvent } from './contracts.ts';
import { countAction, isComputerTool, MAX_COMPUTER_ACTIONS } from './computer.ts';
import { appendNdjson, dataPath } from './paths.ts';
import { store } from './store.ts';
import fs from 'node:fs';

/**
 * The permission broker (HB-PRD-001 F-SEC-01).
 *
 * Every risky action becomes a card in the thread with an explicit outcome and a
 * recorded source. The invariant that matters: no action runs without one of
 * user | auto | timeout | system | peer having decided it, and when nobody can
 * decide, the outcome is `unavailable` and the action does not run. Fail closed.
 */

/** Commands held for a human even under autoApprove. Not exhaustive — deliberately blunt. */
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i,
  /\brmdir\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /:\s*\(\)\s*\{.*\}\s*;/, // fork bomb
  /\bgit\s+push\b.*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bshutdown\b|\breboot\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,
  /\bnpm\s+publish\b/i,
  /Remove-Item[^\n]*-Recurse[^\n]*-Force/i,
  /\bformat\s+[a-z]:/i,
];

export function isDestructive(text: string): string | null {
  for (const re of DESTRUCTIVE) if (re.test(text)) return `matches a destructive pattern (${re.source.slice(0, 40)})`;
  return null;
}

export interface PendingRequest {
  requestId: string;
  botId: string;
  threadId: ThreadId;
  messageId: string;
  instanceId: string;
  toolName?: string;
  summary: string;
  allowKey?: string;
  approvalScope?: 'local-computer';
  openedAt: number;
  timer: NodeJS.Timeout;
}

/** Cards stay durable in the transcript; only this in-memory claim expires. */
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

type Resolver = (req: PendingRequest, outcome: RequestOutcome, source: RequestSource, answer?: string) => void;

class ApprovalBroker {
  private pending = new Map<string, PendingRequest>();
  private resolver: Resolver = () => {};

  onResolve(fn: Resolver): void {
    this.resolver = fn;
  }

  list(): Omit<PendingRequest, 'timer'>[] {
    return [...this.pending.values()].map(({ timer: _t, ...rest }) => rest);
  }

  get(requestId: string): PendingRequest | undefined {
    return this.pending.get(requestId);
  }

  listForBot(botId: string): Omit<PendingRequest, 'timer'>[] {
    return this.list().filter((r) => r.botId === botId);
  }

  /**
   * Turn a driver's request.opened into a card, after checking whether it is already
   * covered by a remembered grant. Returns true when the broker auto-answered it.
   */
  open(bot: BotRecord, event: Extract<RuntimeEvent, { type: 'request.opened' }>, instanceId: string): boolean {
    const requestId = event.requestId;
    if (!requestId) return false;

    const scope = event.approvalScope;
    const allowKey = event.allowKey;
    const held = event.requestKind === 'permission' ? isDestructive(`${event.toolName ?? ''} ${event.summary}`) : null;

    if (event.requestKind === 'permission' && isComputerTool(event.toolName, scope)) {
      const cap = countAction(bot.id);
      if (!cap.allowed) {
        this.record(bot, event, requestId, 'unavailable', 'system', allowKey, scope);
        this.resolver(
          { requestId, botId: bot.id, threadId: bot.threadId, messageId: '', instanceId, summary: event.summary, openedAt: Date.now(), timer: 0 as never },
          'unavailable',
          'system',
        );
        store.appendMessage(bot.threadId, {
          role: 'bot',
          kind: 'activity',
          text: `Computer action ceiling reached (${MAX_COMPUTER_ACTIONS} per session).`,
          tool: { name: event.toolName ?? 'computer', ok: false },
        });
        return true;
      }
    }

    // A remembered grant only applies inside its own scope. A cloud-tool grant can
    // never authorise the real keyboard and mouse (HB-TRD-001 consideration 5).
    if (event.requestKind === 'permission' && allowKey && !held && this.remembered(bot, allowKey, scope)) {
      this.record(bot, event, requestId, 'allowed-once', 'auto', allowKey, scope);
      this.resolver(
        { requestId, botId: bot.id, threadId: bot.threadId, messageId: '', instanceId, summary: event.summary, openedAt: Date.now(), timer: 0 as never },
        'allowed-once',
        'auto',
      );
      return true;
    }

    // autoApprove continues without stopping — except for questions, which need a
    // human answer by definition, and except for the destructive hold list.
    if (bot.autoApprove && event.requestKind === 'permission' && !held && !scope) {
      this.record(bot, event, requestId, 'allowed-once', 'auto', allowKey, scope);
      this.resolver(
        { requestId, botId: bot.id, threadId: bot.threadId, messageId: '', instanceId, summary: event.summary, openedAt: Date.now(), timer: 0 as never },
        'allowed-once',
        'auto',
      );
      return true;
    }

    const card: OptionCardData = {
      title: event.requestKind === 'question' ? 'The agent has a question' : `${event.toolName ?? 'Tool'} needs approval`,
      subtitle: event.summary,
      requestId,
      tool: event.toolName,
      allowKey,
      approvalScope: scope,
      held: held ?? undefined,
      // Least-destructive last so the mouse never lands on Allow by momentum.
      options:
        event.requestKind === 'question'
          ? (event.choices ?? [{ id: 'answer', label: 'Answer' }])
          : [
              { id: 'deny', label: 'Deny', destructive: true },
              ...(allowKey && !scope ? [{ id: 'always', label: `Always allow ${allowKey}` }] : []),
              { id: 'allow', label: 'Allow once' },
            ],
    };

    const message = store.appendMessage(bot.threadId, { role: 'bot', kind: 'options', card });
    store.setActivity(bot.id, 'waiting-on-you');

    const timer = setTimeout(() => {
      // Nobody answered in time. Timing out must not become permission.
      this.resolve(requestId, 'unavailable', 'timeout');
    }, REQUEST_TIMEOUT_MS);
    timer.unref?.();

    this.pending.set(requestId, {
      requestId,
      botId: bot.id,
      threadId: bot.threadId,
      messageId: message.id,
      instanceId,
      toolName: event.toolName,
      summary: event.summary,
      allowKey,
      approvalScope: scope,
      openedAt: Date.now(),
      timer,
    });
    return false;
  }

  private remembered(bot: BotRecord, allowKey: string, scope?: 'local-computer'): boolean {
    const list = scope === 'local-computer' ? bot.alwaysAllowLocalComputer : bot.alwaysAllow;
    return (list ?? []).includes(allowKey);
  }

  /**
   * Broadening to "Always allow" is a separate explicit step, bound to the
   * server-issued key of a request that is actually pending. A client cannot invent
   * a wider key, and the companion cannot widen one either.
   */
  remember(botId: string, requestId: string): string | null {
    const req = this.pending.get(requestId);
    const bot = store.getBot(botId);
    if (!req || !bot || !req.allowKey || req.botId !== botId) return null;
    const field = req.approvalScope === 'local-computer' ? 'alwaysAllowLocalComputer' : 'alwaysAllow';
    const list = new Set(bot[field] ?? []);
    list.add(req.allowKey);
    store.updateBot(botId, { [field]: [...list] } as Partial<BotRecord>);
    return req.allowKey;
  }

  resolve(requestId: string, outcome: RequestOutcome, source: RequestSource, answer?: string): PendingRequest | null {
    const req = this.pending.get(requestId);
    if (!req) return null;
    clearTimeout(req.timer);
    this.pending.delete(requestId);

    const bot = store.getBot(req.botId);
    if (bot) {
      const label =
        outcome === 'allowed-once' ? 'allow' : outcome === 'rejected' ? 'deny' : outcome === 'answered' ? 'answered' : 'unavailable';
      const existing = store.getMessage(req.threadId, req.messageId);
      if (existing?.card) {
        store.patchMessage(req.threadId, req.messageId, {
          card: { ...existing.card, answered: answer ? `answered: ${answer}` : label },
        });
      }
      writeDecision({
        at: Date.now(),
        botId: req.botId,
        threadId: req.threadId,
        requestId,
        tool: req.toolName,
        summary: req.summary,
        outcome,
        source,
        allowKey: req.allowKey,
        approvalScope: req.approvalScope,
      });
    }

    this.resolver(req, outcome, source, answer);
    return req;
  }

  /**
   * A turn ended with cards still open. They can never be answered now, so they
   * resolve as unavailable — which means the action does not run.
   */
  cancelForThread(threadId: ThreadId, source: RequestSource = 'system'): void {
    // Copy first: resolve() deletes from the same map we are walking.
    // oxlint-disable-next-line unicorn/no-useless-spread -- intentional snapshot
    for (const req of [...this.pending.values()]) {
      if (req.threadId === threadId) this.resolve(req.requestId, 'unavailable', source);
    }
  }

  cancelForBot(botId: string): void {
    // Copy first: resolve() deletes from the same map we are walking.
    // oxlint-disable-next-line unicorn/no-useless-spread -- intentional snapshot
    for (const req of [...this.pending.values()]) {
      if (req.botId === botId) this.resolve(req.requestId, 'unavailable', 'system');
    }
  }

  private record(
    bot: BotRecord,
    event: Extract<RuntimeEvent, { type: 'request.opened' }>,
    requestId: string,
    outcome: RequestOutcome,
    source: RequestSource,
    allowKey?: string,
    scope?: 'local-computer',
  ): void {
    writeDecision({
      at: Date.now(),
      botId: bot.id,
      threadId: bot.threadId,
      requestId,
      tool: event.toolName,
      summary: event.summary,
      outcome,
      source,
      allowKey,
      approvalScope: scope,
    });
  }
}

const DECISIONS_FILE = dataPath('decisions.ndjson');
const DECISIONS_MAX_BYTES = 4 * 1024 * 1024;

function writeDecision(entry: DecisionLogEntry): void {
  try {
    if (fs.statSync(DECISIONS_FILE).size > DECISIONS_MAX_BYTES) fs.renameSync(DECISIONS_FILE, `${DECISIONS_FILE}.1`);
  } catch {
    // No log yet, or rotation lost a race. Either way, keep appending.
  }
  appendNdjson(DECISIONS_FILE, entry);
}

export function readDecisions(limit = 200): DecisionLogEntry[] {
  try {
    return fs
      .readFileSync(DECISIONS_FILE, 'utf8')
      .trim()
      .split('\n')
      .slice(-limit)
      .map((l) => JSON.parse(l) as DecisionLogEntry);
  } catch {
    return [];
  }
}

/** Card options map to outcomes in exactly one place. */
export function outcomeForChoice(choiceId: string): RequestOutcome {
  if (choiceId === 'allow' || choiceId === 'always') return 'allowed-once';
  if (choiceId === 'deny') return 'rejected';
  return 'answered';
}

export const approvals = new ApprovalBroker();
