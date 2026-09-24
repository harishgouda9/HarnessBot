import { Badge, Button, EmptyState, ErrorState, Loader, ScrollArea, SearchField, StatusDot, cn, useQuery } from '@hermes/plugin-sdk';
import { useMemo, useState } from 'react';
import type { BotRecord } from '../../../../shared/types.ts';
import { Harness, KEYS, type PluginCtx } from './harness.ts';
import { ACTIVITY_LABEL, matches, sectionsOf, toneFor } from './logic.ts';

/**
 * The roster, in Hermes' own components.
 *
 * This is the piece that makes HarnessBot a feature rather than an embedded site:
 * the rows, the search field and the status dots are the same ones Hermes draws
 * everywhere else, so it inherits the theme, the density and the keyboard
 * behaviour instead of approximating them.
 */

export function BotRow({
  bot,
  selected,
  onSelect,
}: {
  bot: BotRecord;
  selected: boolean;
  onSelect: (bot: BotRecord) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(bot)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        selected ? 'bg-(--ui-fill-secondary)' : 'hover:bg-(--ui-fill-tertiary)',
      )}
    >
      <StatusDot tone={toneFor(bot)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{bot.name}</span>
        {bot.title ? <span className="block truncate text-xs text-(--ui-text-tertiary)">{bot.title}</span> : null}
      </span>
      {bot.activity && bot.activity !== 'idle' ? (
        <Badge>{ACTIVITY_LABEL[bot.activity] ?? bot.activity}</Badge>
      ) : null}
    </button>
  );
}

export function RosterPane({
  ctx,
  onOpen,
  onLaunch,
}: {
  ctx: PluginCtx;
  onOpen: (bot: BotRecord) => void;
  onLaunch?: () => void;
}) {
  const harness = useMemo(() => new Harness(ctx), [ctx]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const bots = useQuery({
    queryKey: KEYS.bots,
    queryFn: () => harness.bots(),
    // Polled, not streamed: see the note in logic.ts — Hermes' auth gate does
    // not cover WebSocket routes, so there is no socket to lean on here.
    refetchInterval: 10_000,
  });

  if (bots.isLoading) return <Loader label="Loading the roster…" />;
  if (bots.error) {
    return (
      <ErrorState
        title="HarnessBot is not answering"
        description={String((bots.error as Error)?.message ?? bots.error)}
        action={<Button onClick={() => void bots.refetch()}>Try again</Button>}
      />
    );
  }

  const all = bots.data ?? [];
  if (!all.length) {
    return (
      <EmptyState
        title="No bots yet"
        description="Open HarnessBot to create one."
        action={onLaunch ? <Button onClick={onLaunch}>Open HarnessBot</Button> : undefined}
      />
    );
  }

  const visible = all.filter((bot) => matches(bot, query));
  const sections = sectionsOf(visible);

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      {onLaunch ? (
        <Button size="sm" onClick={onLaunch}>
          Open HarnessBot
        </Button>
      ) : null}
      <SearchField value={query} onValueChange={setQuery} placeholder="Search bots" />
      <ScrollArea className="min-h-0 flex-1">
        {sections.map((section) => (
          <div key={section.name} className="mb-2">
            <div className="px-2 pb-1 text-xs text-(--ui-text-tertiary)">{section.name}</div>
            {section.bots.map((bot) => (
              <BotRow
                key={bot.id}
                bot={bot}
                selected={bot.id === selected}
                onSelect={(next) => {
                  setSelected(next.id);
                  onOpen(next);
                }}
              />
            ))}
          </div>
        ))}
        {!visible.length ? <div className="px-2 py-4 text-sm text-(--ui-text-tertiary)">Nothing matches “{query}”.</div> : null}
      </ScrollArea>
    </div>
  );
}
