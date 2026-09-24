import {
  Button,
  EmptyState,
  GlyphSpinner,
  Loader,
  ScrollArea,
  Separator,
  Streamdown,
  Textarea,
  cn,
  useQuery,
  useQueryClient,
} from '@hermes/plugin-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BotRecord, Message, OptionCardChoice } from '../../../../shared/types.ts';
import { Harness, KEYS, type PluginCtx } from './harness.ts';
import { ago, pollIntervalFor, visibleMessages } from './logic.ts';

/**
 * A bot's conversation, drawn with Hermes' own transcript furniture.
 *
 * Freshness is polled rather than streamed — Hermes' auth gate does not cover
 * WebSocket routes, and a socket into a harness with no auth of its own would be
 * an unauthenticated door. So the interval follows the bot instead: fast while it
 * is working, slow while it is not, which is where the cost actually is.
 */

function ApprovalCard({
  message,
  onAnswer,
  busy,
}: {
  message: Message;
  onAnswer: (choice: OptionCardChoice) => void;
  busy: boolean;
}) {
  const card = message.card!;
  return (
    <div className="rounded-md border border-(--ui-stroke-secondary) p-2">
      <div className="text-sm font-medium">{card.title}</div>
      {card.subtitle ? <div className="mt-0.5 text-xs text-(--ui-text-secondary)">{card.subtitle}</div> : null}
      {card.held ? <div className="mt-1 text-xs text-(--ui-text-secondary)">Held: {card.held}</div> : null}
      {card.answered ? (
        <div className="mt-1.5 text-xs text-(--ui-text-tertiary)">Answered: {card.answered}</div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(card.options ?? []).map((choice) => (
            <Button key={choice.id} size="sm" disabled={busy} onClick={() => onAnswer(choice)}>
              {choice.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({ message, onAnswer, busy }: { message: Message; onAnswer: (c: OptionCardChoice) => void; busy: boolean }) {
  if (message.card) return <ApprovalCard message={message} onAnswer={onAnswer} busy={busy} />;

  const mine = message.role === 'user';
  return (
    <div className={cn('flex flex-col gap-0.5', mine ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[46rem] rounded-md px-2.5 py-1.5 text-sm',
          mine ? 'bg-(--ui-fill-secondary)' : 'bg-(--ui-fill-tertiary)',
        )}
      >
        {message.tool && !message.text ? (
          <span className="text-xs text-(--ui-text-secondary)">
            {message.tool.name}
            {message.tool.ok === false ? ' failed' : ''}
          </span>
        ) : (
          <Streamdown>{message.text ?? ''}</Streamdown>
        )}
      </div>
      <span className="text-[0.6875rem] text-(--ui-text-tertiary)">
        {message.from?.name ? `${message.from.name} · ` : ''}
        {ago(message.at)}
      </span>
    </div>
  );
}

export function ChatView({ ctx, bot }: { ctx: PluginCtx; bot: BotRecord }) {
  const harness = useMemo(() => new Harness(ctx), [ctx]);
  const queries = useQueryClient();
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const threadId = bot.threadId;
  const thread = useQuery({
    queryKey: KEYS.thread(threadId),
    queryFn: () => harness.messages(threadId),
    refetchInterval: pollIntervalFor(bot),
  });

  const messages = visibleMessages(thread.data?.messages ?? []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const refresh = (): void => {
    void queries.invalidateQueries({ queryKey: KEYS.thread(threadId) });
    void queries.invalidateQueries({ queryKey: KEYS.bots });
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft('');
    try {
      await harness.send(bot.id, text, threadId);
    } finally {
      setSending(false);
      refresh();
    }
  };

  const answer = async (choice: OptionCardChoice, requestId?: string): Promise<void> => {
    if (!requestId) return;
    await harness.respond(bot.id, requestId, choice.id);
    refresh();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-sm font-medium">{bot.name}</span>
        {bot.title ? <span className="text-xs text-(--ui-text-tertiary)">{bot.title}</span> : null}
        {bot.activity === 'working' ? <GlyphSpinner /> : null}
        <span className="flex-1" />
        {bot.activity === 'working' ? (
          <Button size="sm" variant="ghost" onClick={() => void harness.interrupt(bot.id).then(refresh)}>
            Interrupt
          </Button>
        ) : null}
      </div>
      <Separator />

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {thread.isLoading ? <Loader label="Loading the conversation…" /> : null}
          {!thread.isLoading && !messages.length ? (
            <EmptyState title="Nothing here yet" description={`Say something to ${bot.name}.`} />
          ) : null}
          {messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              busy={sending}
              onAnswer={(choice) => void answer(choice, message.card?.requestId)}
            />
          ))}
          <div ref={bottom} />
        </div>
      </ScrollArea>

      <Separator />
      <div className="flex items-end gap-2 p-2">
        <Textarea
          value={draft}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={`Message ${bot.name}…`}
          className="min-h-0 flex-1 resize-none"
        />
        <Button disabled={!draft.trim() || sending} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}
