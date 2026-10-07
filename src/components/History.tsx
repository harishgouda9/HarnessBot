import { useEffect, useState } from 'react';
import type { HistoryEntry } from '../../shared/types.ts';
import { api } from '../api.ts';
import { jumpToThread, useStore } from '../store.tsx';
import { PageHeader } from './PageHeader.tsx';

/**
 * Past chats across the roster. The rows are the tasks and rooms that already
 * exist; opening one switches to that thread.
 */

const inputStyle = { background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' } as const;

function when(at: number): string {
  if (!at) return '';
  return new Date(at).toLocaleString();
}

export function HistoryPage() {
  const store = useStore();
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let gone = false;
    const handle = window.setTimeout(() => {
      void api
        .get<HistoryEntry[]>(`/api/history${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
        .then((list) => {
          if (!gone) {
            setRows(list);
            setError('');
          }
        })
        .catch((err: unknown) => {
          if (gone) return;
          const message = err instanceof Error ? err.message : 'Could not load history';
          setError(message === 'not found' ? 'old-harness' : message);
        });
    }, query.trim() ? 150 : 0);
    return () => {
      gone = true;
      window.clearTimeout(handle);
    };
  }, [query]);

  const open = (row: HistoryEntry): void => {
    void jumpToThread(store, row.threadId, row.botId);
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <PageHeader
        title="Chat history"
        description="Tasks and rooms already on this roster. Opening one continues that conversation."
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transcripts"
          aria-label="Search transcripts"
          className="basis-full rounded-lg px-2 py-1.5 text-[13px]"
          style={inputStyle}
        />
      </PageHeader>
      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-3">
        {error === 'old-harness' ? (
          <div className="max-w-lg rounded-lg p-3 text-[13px]" style={{ background: 'var(--color-inset)' }}>
            Chat history is in this build. The harness that is running does not have it yet, so this list stays empty until that process is restarted.
          </div>
        ) : error ? (
          <div className="max-w-lg rounded-lg p-3 text-[13px]" style={{ background: 'var(--color-inset)', color: 'var(--color-danger)' }}>
            {error}
          </div>
        ) : rows === null ? (
          <div className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
            Loading history…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
            {query.trim() ? 'No transcripts match that search.' : 'No conversations yet.'}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((row) => (
              <li key={row.threadId}>
                <button
                  type="button"
                  onClick={() => open(row)}
                  className="w-full rounded-lg px-3 py-2 text-left"
                  style={{ background: 'var(--color-panel)' }}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium">{row.title}</span>
                    <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {row.botName ?? (row.kind === 'room' ? 'Room' : 'Chat')}
                    </span>
                    <span className="flex-1" />
                    <span className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {when(row.at)}
                    </span>
                  </span>
                  {row.preview ? (
                    <span className="mt-0.5 block truncate text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
                      {row.preview}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
