import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { BotRecord, GroupRecord, Message } from '../../shared/types.ts';
import { api, apiUrl, speak, uploadAttachment } from '../api.ts';
import { t } from '../i18n.ts';
import { currentModelLabel } from '../model-catalog.ts';
import { snapshotFor, useStore, type InstanceSnapshot } from '../store.tsx';
import { ActivityChip, ApprovalCard, ConnectorCard, GoalRunCard, RoutineRunCard, SecretCard } from './Cards.tsx';
import { ActivityDot, Avatar, botColor } from './Avatar.tsx';
import { Icon, IconButton, type IconName } from './Icons.tsx';
import { isLean } from '../usage.ts';
import { EngineSwitcher } from './Overlays.tsx';
import { ChatModelPicker } from './ChatModelPicker.tsx';

/** How much transcript to mount up front. Older turns expand on demand. */
const WINDOW_SIZE = 60;

/** The right rail's four surfaces, as one segmented group rather than four loose words. */
const PANEL_BUTTONS: { panel: 'computer' | 'inspector' | 'memory' | 'settings'; icon: IconName; label: string }[] = [
  { panel: 'computer', icon: 'monitor', label: 'Computer' },
  { panel: 'inspector', icon: 'pulse', label: 'Inspector' },
  { panel: 'memory', icon: 'brain', label: 'Memory' },
  { panel: 'settings', icon: 'sliders', label: 'Profile and settings' },
];

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** GFM, no raw HTML. Model output is untrusted; it renders as text, never as markup. */
function Markdown({ text }: { text: string }) {
  const withSpoilers = useMemo(() => text.split(/(\|\|[^|]+\|\|)/g), [text]);
  return (
    <div className="md text-[14px] leading-[1.55] break-words">
      {withSpoilers.map((part, i) =>
        part.startsWith('||') && part.endsWith('||') ? (
          <Spoiler key={i} text={part.slice(2, -2)} />
        ) : (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} skipHtml>
            {part}
          </ReactMarkdown>
        ),
      )}
    </div>
  );
}

function Spoiler({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? 'revealed' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => setShown(true)}
      onKeyDown={(e) => e.key === 'Enter' && setShown(true)}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Reacting is a one-tap thing, so the set is short and fixed rather than a picker. */
const REACTIONS = ['👍', '🎉', '👀', '❤️', '😄'];

function Bubble({
  message,
  threadId,
  onReply,
  onEdit,
  onRewind,
  onCancelQueued,
  voice,
  branches,
}: {
  message: Message;
  botId?: string;
  threadId?: string;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRewind: (m: Message) => void;
  onCancelQueued?: (m: Message) => void;
  voice?: string;
  branches?: React.ReactNode;
}) {
  const isUser = message.role === 'user';

  return (
    <div className={`${isUser ? 'anim-msg' : 'anim-reply'} group flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[min(680px,86%)] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
        {message.from ? (
          <div className="px-1 text-[12px] font-medium" style={{ color: botColor(message.from.color) }}>
            {message.from.name}
          </div>
        ) : null}

        {message.replyToId ? (
          <div className="rounded-md px-2 py-1 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            replying to an earlier message
          </div>
        ) : null}

        <div
          className="rounded-2xl px-3 py-2"
          style={
            isUser
              ? { background: 'var(--color-bubble-user)', color: 'var(--color-bubble-ink)' }
              : { background: 'var(--color-card)', border: '1px solid var(--color-hairline)' }
          }
        >
          {message.text ? <Markdown text={message.text} /> : null}
          {message.png ? (
            <img src={`data:${message.mime ?? 'image/png'};base64,${message.png}`} alt="screen" className="mt-1 max-w-full rounded-lg" />
          ) : null}
          {message.attachments?.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {message.attachments.map((a) => (
                <AttachmentChip key={a.id} attachment={a} />
              ))}
            </div>
          ) : null}
          {message.queued ? (
            <div className="mt-1 flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              queued
              {/* A queued message has not run yet, so taking it back is still possible. */}
              {message.queueId && onCancelQueued ? (
                <button type="button" onClick={() => onCancelQueued(message)} className="underline">
                  cancel
                </button>
              ) : null}
            </div>
          ) : null}
          {message.steered ? (
            <div className="mt-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
              steered mid-turn
            </div>
          ) : null}
        </div>

        {message.reactions?.length ? (
          <div className="flex gap-1 px-1">
            {message.reactions.map((r, i) => (
              <button
                key={i}
                type="button"
                disabled={!threadId}
                onClick={() => void api.post(`/api/threads/${threadId}/reactions`, { messageId: message.id, emoji: r.emoji })}
                className="rounded-full px-1.5 text-[12px]"
                style={{ background: 'var(--color-inset)' }}
                aria-label={`Toggle ${r.emoji}`}
              >
                {r.emoji}
              </button>
            ))}
          </div>
        ) : null}

        {branches}

        {/*
          Always in the layout and revealed on hover *or* focus. Mounting it on hover
          moved every bubble below it, and left the actions unreachable by keyboard.
        */}
        <div
          className="flex flex-wrap items-center gap-2 px-1 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          style={{ color: 'var(--color-ink-secondary)' }}
        >
          {threadId
            ? REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => void api.post(`/api/threads/${threadId}/reactions`, { messageId: message.id, emoji })}
                  aria-label={`React ${emoji}`}
                >
                  {emoji}
                </button>
              ))
            : null}
          <button type="button" onClick={() => onReply(message)}>
            Reply
          </button>
          {isUser ? (
            <button type="button" onClick={() => onEdit(message)}>
              Edit
            </button>
          ) : null}
          <button type="button" onClick={() => onRewind(message)}>
            Rewind here
          </button>
          {!isUser && message.text ? (
            <button type="button" onClick={() => void speak(message.text!, voice).then((a) => a.play())}>
              Speak
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MessageItem(props: {
  message: Message;
  botId?: string;
  threadId?: string;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRewind: (m: Message) => void;
  onCancelQueued?: (m: Message) => void;
  voice?: string;
  branches?: React.ReactNode;
  focused?: boolean;
  highlight?: string;
}) {
  const { message, focused, highlight } = props;
  const matched = Boolean(highlight && message.text?.toLowerCase().includes(highlight.toLowerCase()));
  return (
    <div
      data-message-id={message.id}
      className={focused ? 'anim-flash rounded-2xl' : undefined}
      style={matched && !focused ? { outline: '1px solid var(--color-accent-border)', borderRadius: 16 } : undefined}
    >
      <MessageBody {...props} />
    </div>
  );
}

function MessageBody(props: {
  message: Message;
  botId?: string;
  threadId?: string;
  onReply: (m: Message) => void;
  onEdit: (m: Message) => void;
  onRewind: (m: Message) => void;
  onCancelQueued?: (m: Message) => void;
  voice?: string;
  branches?: React.ReactNode;
}) {
  const { message, botId } = props;
  switch (message.kind) {
    case 'options':
      return (
        <div className="flex justify-start">
          <ApprovalCard message={message} botId={botId ?? ''} />
        </div>
      );
    case 'connector':
      return (
        <div className="flex justify-start">
          <ConnectorCard message={message} />
        </div>
      );
    case 'secret':
      return (
        <div className="flex justify-start">
          <SecretCard message={message} botId={botId ?? ''} />
        </div>
      );
    case 'routine.run':
      return (
        <div className="flex justify-start">
          <RoutineRunCard message={message} />
        </div>
      );
    case 'goal.run':
      return (
        <div className="flex justify-start">
          <GoalRunCard message={message} />
        </div>
      );
    case 'activity':
      return (
        <div className="flex justify-start">
          <ActivityChip message={message} />
        </div>
      );
    case 'comm':
      return (
        <div className="flex justify-start">
          <div className="rounded-full px-2.5 py-1 text-[12px]" style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}>
            {message.comm?.kind === 'delegate' ? 'delegated to' : 'asked'} {message.comm?.peerName}: {message.text?.slice(0, 80)}
          </div>
        </div>
      );
    default:
      return <Bubble {...props} />;
  }
}

// ---------------------------------------------------------------------------
// Find in chat
// ---------------------------------------------------------------------------

/** Counting matches is not finding them: this walks the hits and scrolls to each one. */
function ChatFindBar({
  messages,
  query,
  onQuery,
  onGo,
  onClose,
}: {
  messages: Message[];
  query: string;
  onQuery: (q: string) => void;
  onGo: (messageId: string) => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const hits = useMemo(
    () => (query.length > 1 ? messages.filter((m) => m.text?.toLowerCase().includes(query.toLowerCase())) : []),
    [messages, query],
  );

  const go = (next: number): void => {
    if (!hits.length) return;
    const wrapped = (next + hits.length) % hits.length;
    setIndex(wrapped);
    onGo(hits[wrapped]!.id);
  };

  // Typing lands you on the first match; Enter and the arrows walk from there.
  const first = hits[0]?.id;
  useEffect(() => {
    if (first) onGo(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first]);

  return (
    <div className="flex items-center gap-2 border-b px-3 py-2 hairline" style={{ background: 'var(--color-panel)' }}>
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          onQuery(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? index - 1 : index + 1);
          }
        }}
        placeholder="Find in chat"
        className="flex-1 rounded-lg px-2 py-1 text-[13px]"
        style={{ background: 'var(--color-inset)', color: 'var(--color-ink)' }}
      />
      <span className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
        {hits.length ? `${index + 1} of ${hits.length}` : `0 matches`}
      </span>
      <button type="button" onClick={() => go(index - 1)} disabled={!hits.length} className="text-[12px] disabled:opacity-40" aria-label="Previous match">
        ↑
      </button>
      <button type="button" onClick={() => go(index + 1)} disabled={!hits.length} className="text-[12px] disabled:opacity-40" aria-label="Next match">
        ↓
      </button>
      <button
        type="button"
        onClick={() => {
          onQuery('');
          onClose();
        }}
        className="text-[12px]"
      >
        Close
      </button>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: { id: string; name: string; mime: string; url: string };
  onRemove?: () => void;
}) {
  const href = apiUrl(attachment.url);
  const kind = attachment.mime.startsWith('image/') ? 'image' : attachment.mime.startsWith('video/') ? 'video' : 'file';
  if (!onRemove && kind === 'image') {
    return <img src={href} alt={attachment.name} className="mt-1 max-h-56 max-w-full rounded-lg" />;
  }
  if (!onRemove && kind === 'video') {
    return <video src={href} controls className="mt-1 max-h-56 max-w-full rounded-lg" />;
  }
  return (
    <span className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px]" style={{ background: 'var(--color-inset)' }}>
      {kind === 'image' ? (
        <img src={href} alt="" className="h-6 w-6 rounded object-cover" />
      ) : (
        <Icon name={kind === 'video' ? 'film' : 'file'} size={12} />
      )}
      <a href={href} target="_blank" rel="noreferrer" className="max-w-32 truncate underline" style={{ color: 'var(--color-accent)' }}>
        {attachment.name}
      </a>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${attachment.name}`} className="grid h-5 w-5 place-items-center">
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

function Composer({
  placeholder,
  busy,
  snapshot,
  pendingApproval,
  onSend,
  onInterrupt,
  replyTo,
  onClearReply,
  bot,
}: {
  placeholder: string;
  busy: boolean;
  snapshot?: InstanceSnapshot;
  pendingApproval: boolean;
  onSend: (
    text: string,
    opts: { images?: { mime: string; data: string }[]; attachments?: Message['attachments']; context?: string; injectNow?: boolean },
  ) => void;
  onInterrupt: () => void;
  replyTo?: Message | null;
  onClearReply: () => void;
  bot?: BotRecord;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ id: string; name: string; mime: string; url: string }[]>([]);
  const [context, setContext] = useState('');
  const [menu, setMenu] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  const canSteer = snapshot?.capabilities.steer ?? false;
  const canQueue = snapshot?.capabilities.queueing ?? false;
  // While a card is open the composer is not the way forward: the card is.
  const disabled = pendingApproval || (busy && !canSteer && !canQueue);
  const canSend = Boolean(text.trim() || files.length || context.trim());

  const addFiles = async (list: File[]): Promise<void> => {
    if (!list.length) return;
    setUploading(true);
    try {
      const uploaded = await Promise.all(list.map(uploadAttachment));
      setFiles((prev) => [...prev, ...uploaded]);
    } finally {
      setUploading(false);
    }
  };

  const submit = (injectNow = false): void => {
    if (!canSend) return;
    onSend(text.trim(), {
      attachments: files.length ? files : undefined,
      context: context.trim() || undefined,
      injectNow,
    });
    setText('');
    setFiles([]);
    setContext('');
    setContextOpen(false);
    if (ref.current) {
      ref.current.style.height = 'auto';
    }
  };

  const onPaste = async (e: React.ClipboardEvent): Promise<void> => {
    const items = [...e.clipboardData.files];
    if (!items.length) return;
    e.preventDefault();
    await addFiles(items);
  };

  const pick = (input: HTMLInputElement | null): void => {
    setMenu(false);
    input?.click();
  };

  return (
    <div
      className="relative border-t px-3 py-2 hairline"
      style={{ background: 'var(--color-panel)' }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void addFiles([...e.dataTransfer.files]);
      }}
    >
      {dragging ? (
        <div
          className="pointer-events-none absolute inset-1 z-10 grid place-items-center rounded-xl text-[13px] font-medium"
          style={{ background: 'color-mix(in srgb, var(--color-accent) 14%, var(--color-panel))', border: '1px dashed var(--color-accent-border)' }}
        >
          Drop files, images or video
        </div>
      ) : null}

      <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => void addFiles([...e.target.files!]).then(() => { e.target.value = ''; })} />
      <input ref={imageRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void addFiles([...e.target.files!]).then(() => { e.target.value = ''; })} />
      <input ref={videoRef} type="file" accept="video/*" multiple className="hidden" onChange={(e) => void addFiles([...e.target.files!]).then(() => { e.target.value = ''; })} />

      {replyTo ? (
        <div className="mb-1 flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Replying to: {replyTo.text?.slice(0, 60)}
          <button type="button" onClick={onClearReply}>
            clear
          </button>
        </div>
      ) : null}

      {files.length ? (
        <div className="mb-1 flex flex-wrap gap-1">
          {files.map((f) => (
            <AttachmentChip key={f.id} attachment={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
          ))}
        </div>
      ) : null}

      {contextOpen ? (
        <textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          placeholder="Context for this turn only — a brief, a snippet, a constraint."
          rows={2}
          className="mb-1 w-full resize-none rounded-lg px-2 py-1.5 text-[12px]"
          style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
        />
      ) : context ? (
        <div className="mb-1 flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Context attached
          <button type="button" onClick={() => setContextOpen(true)}>
            edit
          </button>
          <button type="button" onClick={() => setContext('')}>
            clear
          </button>
        </div>
      ) : null}

      {pendingApproval ? (
        <div className="mb-1 text-[12px]" style={{ color: 'var(--color-warning)' }}>
          Waiting on your answer in the card above.
        </div>
      ) : null}

      {uploading ? (
        <div className="mb-1 text-[12px]" style={{ color: 'var(--color-ink-secondary)' }}>
          Uploading…
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <div className="relative">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMenu(!menu)}
            title="Attach file, image, video or context"
            aria-label="Attach file, image, video or context"
            aria-expanded={menu}
            className="grid h-9 w-9 place-items-center rounded-xl disabled:opacity-40"
            style={{ background: 'var(--color-inset)', color: 'var(--color-ink-secondary)' }}
          >
            <Icon name="paperclip" size={16} />
          </button>
          {menu ? (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
              <div className="card absolute bottom-11 left-0 z-30 w-44 py-1" style={{ background: 'var(--color-raised)' }}>
                {(
                  [
                    { icon: 'file' as const, label: 'File', run: () => pick(fileRef.current) },
                    { icon: 'image' as const, label: 'Image', run: () => pick(imageRef.current) },
                    { icon: 'film' as const, label: 'Video', run: () => pick(videoRef.current) },
                    {
                      icon: 'book' as const,
                      label: 'Context',
                      run: () => {
                        setMenu(false);
                        setContextOpen(true);
                      },
                    },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.run}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px]"
                  >
                    <Icon name={item.icon} size={14} />
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onPaste={(e) => void onPaste(e)}
          onChange={(e) => {
            setText(e.target.value);
            const el = e.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(180, el.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="max-h-[180px] min-h-9 flex-1 resize-none rounded-xl px-3 py-2 text-[14px] disabled:opacity-50"
          style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
        />

        {bot ? <ChatModelPicker bot={bot} /> : null}

        {busy ? (
          <button
            type="button"
            onClick={onInterrupt}
            className="min-h-9 rounded-xl px-3 text-[13px]"
            style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
          >
            Stop
          </button>
        ) : null}

        {/* Inject now interrupts the live turn. Only offered while there is one. */}
        {busy && canQueue ? (
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={!canSend}
            className="min-h-9 rounded-xl px-3 text-[13px] disabled:opacity-40"
            style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
          >
            Inject now
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => submit()}
          disabled={disabled || !canSend}
          className="min-h-9 rounded-xl px-4 text-[13px] font-medium disabled:opacity-40"
          style={{ background: 'var(--color-accent)', color: 'var(--color-accent-ink)' }}
        >
          {busy && canQueue ? 'Queue' : busy && canSteer ? 'Steer' : t('app.send')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * A task is a whole conversation with its own transcript, session and usage, so the
 * things you can do to one — rename, delete, export — belong together rather than
 * scattered across a header that has run out of room.
 */
function TaskMenu({
  bot,
  branchesOpen,
  onBranches,
  onChanged,
}: {
  bot: BotRecord;
  branchesOpen: boolean;
  onBranches: () => void;
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const tasks = bot.tasks ?? [];
  const current = tasks.find((task) => task.threadId === bot.threadId);

  const item = (label: string, run: () => void | Promise<void>, danger?: boolean) => (
    <button
      type="button"
      onClick={async () => {
        await run();
        setOpen(false);
      }}
      className="block w-full px-3 py-1.5 text-left text-[13px]"
      style={{ color: danger ? 'var(--color-danger)' : 'var(--color-ink)' }}
    >
      {label}
    </button>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="rounded-lg px-2 py-1 text-[12px]"
        style={{ background: 'var(--color-raised)' }}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Task ⌄
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="card anim-pop absolute right-0 z-30 mt-1 w-56 py-1" style={{ background: 'var(--color-raised)' }}>
            {item('New task', async () => {
              await api.post(`/api/bots/${bot.id}/tasks`, { title: 'New task' });
              await onChanged();
            })}
            {item('Rename this task', async () => {
              const title = window.prompt('Task name', current?.title ?? '');
              if (!title?.trim()) return;
              await api.patch(`/api/bots/${bot.id}/tasks/${bot.threadId}`, { title: title.trim() });
              await onChanged();
            })}
            {item('Export transcript', async () => {
              const data = await api.get<unknown>(`/api/threads/${bot.threadId}/export`);
              const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
              const link = document.createElement('a');
              link.href = url;
              link.download = `${bot.name}-${current?.title ?? 'task'}.json`.replace(/[^\w.-]/g, '-');
              link.click();
              URL.revokeObjectURL(url);
            })}
            {item(branchesOpen ? 'Hide other versions' : 'Show other versions', onBranches)}
            {tasks.length > 1
              ? item(
                  'Delete this task',
                  async () => {
                    // A task takes its whole transcript with it, so it asks first.
                    if (!window.confirm(`Delete "${current?.title ?? 'this task'}" and its transcript? This cannot be undone.`)) return;
                    await api.del(`/api/bots/${bot.id}/tasks/${bot.threadId}`);
                    await onChanged();
                  },
                  true,
                )
              : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat view
// ---------------------------------------------------------------------------

export function ChatView({
  bot,
  onOpenPanel,
  compact = false,
  onClose,
}: {
  bot: BotRecord;
  onOpenPanel: (panel: 'computer' | 'inspector' | 'memory' | 'settings' | null) => void;
  /** Drawer mode: the same surface with fewer header controls, not a second copy of it. */
  compact?: boolean;
  onClose?: () => void;
}) {
  const { state, dispatch, loadThread, refreshBots } = useStore();
  const snapshot = snapshotFor(state, bot);
  const thread = state.threads[bot.threadId];
  const [expanded, setExpanded] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [allMessages, setAllMessages] = useState<Message[] | null>(null);
  const [switching, setSwitching] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadThread(bot.threadId);
    setExpanded(false);
    setAllMessages(null);
  }, [bot.threadId, loadThread]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const messages = thread?.messages ?? [];
  const streaming = state.streaming[bot.threadId];
  useEffect(() => {
    // Streaming grows the last bubble without adding one, so it has to scroll too.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streaming]);

  // Jump targets from search, the palette, or find-in-chat all land here.
  const focusId = state.focusMessageId;
  useEffect(() => {
    if (!focusId) return;
    setExpanded(true);
    const node = scroller.current?.querySelector(`[data-message-id="${CSS.escape(focusId)}"]`);
    node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(() => dispatch({ type: 'focus', messageId: null }), 1600);
    return () => window.clearTimeout(timer);
  }, [focusId, messages.length, dispatch]);

  // Mount a tail and expand on demand: a computer-use thread can be thousands long.
  const visible = expanded ? messages : messages.slice(-WINDOW_SIZE);
  const hidden = messages.length - visible.length;

  /**
   * Branches only matter once one exists. Rewinding or editing forks the transcript,
   * and the other fork is still on disk — reachable here rather than silently lost.
   */
  const showBranches = async (): Promise<void> => {
    if (allMessages) return setAllMessages(null);
    const data = await api.get<{ messages: Message[] }>(`/api/threads/${bot.threadId}/messages?all=true`);
    setAllMessages(data.messages);
  };

  const branchesFor = (message: Message): React.ReactNode => {
    if (!allMessages || message.parentId === undefined) return null;
    const siblings = allMessages.filter((m) => (m.parentId ?? null) === (message.parentId ?? null)).sort((a, b) => a.at - b.at);
    if (siblings.length < 2) return null;
    const at = siblings.findIndex((m) => m.id === message.id);

    // Follow the newest child each step down, so switching lands on that fork's tip.
    const leafOf = (id: string): string => {
      let cursor = id;
      for (let guard = 0; guard < 5000; guard += 1) {
        const child = allMessages.filter((m) => m.parentId === cursor).sort((a, b) => b.at - a.at)[0];
        if (!child) return cursor;
        cursor = child.id;
      }
      return cursor;
    };

    const switchTo = async (index: number): Promise<void> => {
      const target = siblings[(index + siblings.length) % siblings.length];
      if (!target) return;
      await api.post(`/api/bots/${bot.id}/active-branch`, { threadId: bot.threadId, leafId: leafOf(target.id) });
      await loadThread(bot.threadId, true);
    };

    return (
      <div className="flex items-center gap-1.5 px-1 text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        <button type="button" onClick={() => void switchTo(at - 1)} aria-label="Previous version">
          ‹
        </button>
        <span>
          version {at + 1} of {siblings.length}
        </span>
        <button type="button" onClick={() => void switchTo(at + 1)} aria-label="Next version">
          ›
        </button>
      </div>
    );
  };

  const pendingApproval = messages.some((m) => m.kind === 'options' && m.card && !m.card.answered && m.card.requestId);
  const busy = bot.activity === 'working' || bot.activity === 'waiting-on-you';

  const send = (text: string, opts: Parameters<Parameters<typeof Composer>[0]['onSend']>[1]): void => {
    void api.post(`/api/bots/${bot.id}/messages`, {
      text,
      threadId: bot.threadId,
      sendId: crypto.randomUUID(),
      replyToId: replyTo?.id,
      attachments: opts.attachments,
      context: opts.context,
      injectNow: opts.injectNow,
    });
    setReplyTo(null);
  };

  const tasks = bot.tasks ?? [];
  const harnessName = snapshot?.displayName ?? bot.modelSelection.instanceId;
  const modelLabel = currentModelLabel(bot.modelSelection, state.instances).model || bot.modelSelection.model;

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline" style={{ background: 'var(--color-panel)' }}>
        {/* The face is the way into the profile. Looking at a bot and wanting to edit
            it is the same gesture, so it should not need a hunt along the toolbar.
            The drawer has no rail to open, so there it stays a picture. */}
        {compact ? (
          <Avatar name={bot.name} color={bot.color} activity={bot.activity} expression={bot.mascotExpression} avatarUrl={bot.avatarUrl} size={30} />
        ) : (
          <button
            type="button"
            onClick={() => onOpenPanel('settings')}
            title={`${bot.name} — profile and settings`}
            aria-label={`${bot.name} — profile and settings`}
            className="rounded-xl"
          >
            <Avatar name={bot.name} color={bot.color} activity={bot.activity} expression={bot.mascotExpression} avatarUrl={bot.avatarUrl} size={30} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-[4.5rem] truncate text-[14px] font-semibold">{bot.name}</span>
            <span
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
              style={{ background: 'var(--color-inset)', color: 'var(--color-ink)' }}
              title={`${harnessName} is this bot's harness`}
            >
              {harnessName}
            </span>
            <ActivityDot activity={bot.activity} />
            {/* Presence is a small live region, not a banner. */}
            <span className="text-[12px]" style={{ color: 'var(--color-ink-secondary)' }} aria-live="polite">
              {bot.activity === 'working' ? t('app.working') : bot.activity === 'waiting-on-you' ? t('app.waiting') : ''}
            </span>
          </div>
          {/* The engine line was the one thing in the header that showed state and did
              nothing about it. Switching provider meant Settings; now it is one click
              from where the problem is visible. */}
          <button
            type="button"
            onClick={() => setSwitching(true)}
            title="Change engine or model"
            className="flex max-w-full items-center gap-1 truncate rounded-md px-1 py-0.5 text-[12px] hover:opacity-80"
            style={{ color: snapshot?.state === 'unavailable' ? 'var(--color-warning)' : 'var(--color-ink-secondary)' }}
          >
            <span className="truncate">
              {snapshot?.state === 'unavailable' ? snapshot.reason : modelLabel}
            </span>
            {bot.modelSelection.auto ? (
              <span className="shrink-0 rounded px-1 text-[10px]" style={{ background: 'var(--color-inset)' }}>
                auto
              </span>
            ) : null}
            {isLean(bot, state.config?.lean?.enabled !== false) ? (
              <span
                className="shrink-0 rounded px-1 text-[10px]"
                style={{ background: 'var(--color-inset)' }}
                title="Lean is on — this bot sends a tighter prompt"
              >
                lean
              </span>
            ) : null}
          </button>
        </div>

        <select
          value={bot.threadId}
          onChange={(e) => void api.patch(`/api/bots/${bot.id}`, { threadId: e.target.value })}
          className="max-w-40 rounded-lg px-2 py-1 text-[12px]"
          style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
          aria-label="Task"
        >
          {tasks.map((task) => (
            <option key={task.threadId} value={task.threadId}>
              {task.title}
            </option>
          ))}
        </select>
        {compact ? null : (
          <>
            <TaskMenu bot={bot} branchesOpen={Boolean(allMessages)} onBranches={() => void showBranches()} onChanged={refreshBots} />
            <span className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: 'var(--color-inset)' }}>
              {PANEL_BUTTONS.map((item) => (
                <IconButton key={item.panel} icon={item.icon} label={item.label} onClick={() => onOpenPanel(item.panel)} />
              ))}
            </span>
          </>
        )}
        {onClose ? <IconButton icon="close" label="Close chat" tone="raised" onClick={onClose} /> : null}
      </header>

      {finding ? (
        <ChatFindBar
          messages={messages}
          query={findQuery}
          onQuery={setFindQuery}
          onGo={(id) => dispatch({ type: 'focus', messageId: id })}
          onClose={() => setFinding(false)}
        />
      ) : null}

      {bot.pinnedMessageId ? (
        <div className="border-b px-3 py-1.5 text-[12px] hairline" style={{ background: 'var(--color-panel)', color: 'var(--color-ink-secondary)' }}>
          Pinned: {messages.find((m) => m.id === bot.pinnedMessageId)?.text?.slice(0, 120)}
        </div>
      ) : null}

      <div ref={scroller} className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mx-auto mb-3 block rounded-full px-3 py-1 text-[12px]"
            style={{ background: 'var(--color-raised)' }}
          >
            Show {hidden} earlier message{hidden === 1 ? '' : 's'}
          </button>
        ) : null}

        {messages.length === 0 ? (
          <div className="mx-auto mt-16 max-w-md text-center">
            <Avatar name={bot.name} color={bot.color} size={56} />
            <div className="mt-3 text-[15px] font-semibold">{bot.name}</div>
            <div className="mt-1 text-[13px]" style={{ color: 'var(--color-ink-secondary)' }}>
              {bot.title || 'Describe a concrete outcome to get started.'}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          {visible.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              botId={bot.id}
              threadId={bot.threadId}
              voice={bot.voice}
              branches={branchesFor(message)}
              focused={focusId === message.id}
              highlight={finding ? findQuery : undefined}
              onReply={setReplyTo}
              onCancelQueued={(m) => void api.del(`/api/bots/${bot.id}/queue/${m.queueId}`)}
              onEdit={(m) => {
                const next = window.prompt('Edit message', m.text ?? '');
                if (next && next !== m.text) {
                  void api.post(`/api/bots/${bot.id}/messages/${m.id}/edit`, { text: next, threadId: bot.threadId });
                }
              }}
              onRewind={(m) => {
                // Rewinding drops everything after this point from the active path.
                if (!window.confirm('Rewind to here? Later messages leave this branch, and the resume cursors are dropped.')) return;
                void api.post(`/api/bots/${bot.id}/rewind`, { messageId: m.id, threadId: bot.threadId });
              }}
            />
          ))}
        </div>
        <div ref={bottom} />
      </div>

      <Composer
        placeholder={t('composer.placeholder', { name: bot.name })}
        busy={busy}
        snapshot={snapshot}
        pendingApproval={pendingApproval}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onSend={send}
        onInterrupt={() => void api.post(`/api/bots/${bot.id}/interrupt`, { threadId: bot.threadId })}
        bot={bot}
      />

      {switching ? <EngineSwitcher bot={bot} onClose={() => setSwitching(false)} /> : null}
    </div>
  );
}

/** Everything about a room that is not a message: who is in it, and the standing note. */
function RoomSettings({ group, onClose }: { group: GroupRecord; onClose: () => void }) {
  const { state, refreshBots } = useStore();
  const save = async (patch: Partial<GroupRecord>): Promise<void> => {
    await api.patch(`/api/groups/${group.id}`, patch);
    await refreshBots();
  };

  return (
    <div className="border-b px-3 py-3 hairline" style={{ background: 'var(--color-panel)' }}>
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] font-semibold">Room settings</span>
        <button type="button" onClick={onClose} className="text-[12px]">
          Done
        </button>
      </div>

      <label className="mt-2 block text-[12px] font-medium">Name</label>
      <input
        defaultValue={group.name}
        onBlur={(e) => e.target.value.trim() && void save({ name: e.target.value.trim() })}
        maxLength={100}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
      />

      <label className="mt-3 block text-[12px] font-medium">Bulletin</label>
      <div className="text-[11px]" style={{ color: 'var(--color-ink-secondary)' }}>
        Injected into every member's turn, so keep it short — it costs tokens on each one.
      </div>
      <textarea
        defaultValue={group.bulletin}
        onBlur={(e) => void save({ bulletin: e.target.value })}
        rows={2}
        maxLength={2000}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px]"
        style={{ background: 'var(--color-inset)', color: 'var(--color-ink)', border: '1px solid var(--color-hairline)' }}
      />

      <div className="mt-3 text-[12px] font-medium">Members</div>
      <div className="scroll-thin mt-1 max-h-40 overflow-y-auto">
        {state.bots
          .filter((b) => !b.hidden)
          .map((bot) => (
            <label key={bot.id} className="flex items-center gap-2 py-0.5 text-[13px]">
              <input
                type="checkbox"
                checked={group.memberIds.includes(bot.id)}
                onChange={(e) =>
                  void save({
                    memberIds: e.target.checked
                      ? [...group.memberIds, bot.id]
                      : group.memberIds.filter((id) => id !== bot.id),
                  })
                }
              />
              <Avatar name={bot.name} color={bot.color} size={20} />
              {bot.name}
            </label>
          ))}
      </div>
    </div>
  );
}

export function GroupView({ group }: { group: GroupRecord }) {
  const { state, loadThread } = useStore();
  const thread = state.threads[group.threadId];
  const [mode, setMode] = useState<'chat' | 'goal'>('chat');
  const [settings, setSettings] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadThread(group.threadId);
  }, [group.threadId, loadThread]);

  const messages = thread?.messages ?? [];
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const members = group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is BotRecord => !!b);
  const busyBot = members.find((b) => b.id === group.busyBotId);

  return (
    <div className="flex min-w-0 flex-1 flex-col" style={{ background: 'var(--color-app)' }}>
      <header className="flex items-center gap-2 border-b px-3 py-2 hairline" style={{ background: 'var(--color-panel)' }}>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold">{group.name}</div>
          <div className="truncate text-[12px]" style={{ color: 'var(--color-ink-secondary)' }} aria-live="polite">
            {members.map((m) => m.name).join(', ')}
            {busyBot ? ` · ${busyBot.name} is working` : ''}
          </div>
        </div>
        {/* Rooms get clean slates too — the same task model as a bot, not a second one. */}
        {(group.tasks ?? []).length > 1 ? (
          <select
            value={group.threadId}
            onChange={(e) => void api.patch(`/api/groups/${group.id}`, { threadId: e.target.value })}
            className="max-w-40 rounded-lg px-2 py-1 text-[12px]"
            style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
            aria-label="Room task"
          >
            {(group.tasks ?? []).map((task) => (
              <option key={task.threadId} value={task.threadId}>
                {task.title}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          onClick={() => void api.post(`/api/groups/${group.id}/tasks`, { title: 'New task' })}
          className="rounded-lg px-2 py-1 text-[12px]"
          style={{ background: 'var(--color-raised)' }}
        >
          New task
        </button>
        <select
          value={group.defaultResponder}
          onChange={(e) => void api.patch(`/api/groups/${group.id}`, { defaultResponder: e.target.value })}
          className="rounded-lg px-2 py-1 text-[12px]"
          style={{ background: 'var(--color-raised)', color: 'var(--color-ink)' }}
          aria-label="Default responder"
        >
          <option value="member">First member</option>
          <option value="everyone">Everyone</option>
          <option value="mentions">Mentions only</option>
        </select>
        <button
          type="button"
          onClick={() => setMode(mode === 'chat' ? 'goal' : 'chat')}
          className="rounded-lg px-2 py-1 text-[12px]"
          style={{ background: mode === 'goal' ? 'var(--color-accent)' : 'var(--color-raised)', color: mode === 'goal' ? 'var(--color-accent-ink)' : 'var(--color-ink)' }}
        >
          Goal mode
        </button>
        <button
          type="button"
          onClick={() => setSettings(!settings)}
          className="rounded-lg px-2 py-1 text-[12px]"
          style={{ background: settings ? 'var(--color-raised)' : 'transparent' }}
        >
          Room settings
        </button>
      </header>

      {settings ? <RoomSettings group={group} onClose={() => setSettings(false)} /> : null}

      {group.bulletin && !settings ? (
        <div className="border-b px-3 py-1.5 text-[12px] hairline" style={{ background: 'var(--color-panel)', color: 'var(--color-ink-secondary)' }}>
          Bulletin: {group.bulletin}
        </div>
      ) : null}

      <div className="scroll-thin flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-2">
          {messages.map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              /* Cards are answered against the bot that raised them; never a guess. */
              botId={message.from?.botId}
              threadId={group.threadId}
              onReply={() => {}}
              onEdit={() => {}}
              onRewind={() => {}}
            />
          ))}
        </div>
        <div ref={bottom} />
      </div>

      <Composer
        placeholder={mode === 'goal' ? 'Describe the goal for this room' : `Message ${group.name} (use @name to pick someone)`}
        busy={Boolean(group.busyBotId)}
        pendingApproval={false}
        onClearReply={() => {}}
        onSend={(text, opts) =>
          void api.post(`/api/groups/${group.id}/messages`, {
            text,
            channelMode: mode,
            sendId: crypto.randomUUID(),
            attachments: opts.attachments,
            context: opts.context,
          })
        }
        onInterrupt={() => void api.post(`/api/groups/${group.id}/interrupt`)}
      />
    </div>
  );
}
