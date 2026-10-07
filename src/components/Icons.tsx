import type { ReactNode } from 'react';

/**
 * One icon family, drawn inline.
 *
 * Outline only, 24-unit grid, 1.7 stroke, currentColor — so an icon inherits the skin
 * token of whatever it sits in and never needs a second copy per theme. Inline rather
 * than a package because the app ships offline and this is the whole set it uses.
 *
 * Icons are decorative by default (aria-hidden). A control that shows nothing but an
 * icon carries the name itself, on the button.
 */

const PATHS = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 15h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a2 2 0 1 1 4 0v.2A1.6 1.6 0 0 0 17 5.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1.1z" />
    </>
  ),
  bell: (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9" />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" />
    </>
  ),
  phone: <path d="M15.6 13.6a10 10 0 0 1-5.2-5.2l1.7-1.7a1 1 0 0 0 .2-1.1L11 3.1a1 1 0 0 0-1.1-.6l-3.3.6A1.4 1.4 0 0 0 5.5 4.6 15.5 15.5 0 0 0 19.4 18.5a1.4 1.4 0 0 0 1.5-1.1l.6-3.3a1 1 0 0 0-.6-1.1l-2.5-1.3a1 1 0 0 0-1.1.2z" />,
  plug: (
    <>
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 18v3" />
    </>
  ),
  map: (
    <>
      <path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5z" />
      <path d="M9 4v14M15 6.5v14" />
    </>
  ),
  book: (
    <>
      <path d="M4 5.5A2 2 0 0 1 6 3.5h13v14H6a2 2 0 0 0-2 2z" />
      <path d="M4 19.5a2 2 0 0 0 2 2h13v-4" />
    </>
  ),
  record: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  apps: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4" width="17" height="7" rx="2" />
      <rect x="3.5" y="13" width="17" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  chevronLeft: <path d="M14.5 6 8.5 12l6 6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronUp: <path d="M6 14.5 12 8.5l6 6" />,
  chevronDown: <path d="M6 9.5 12 15.5l6-6" />,
  panelRight: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      <path d="M15 4v16" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8h.01" />
    </>
  ),
  wand: (
    <>
      <path d="m4 20 11-11" />
      <path d="M14.5 4.5 15.5 7l2.5 1-2.5 1-1 2.5-1-2.5L11 8l2.5-1z" />
      <path d="M19 14.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
    </>
  ),
  fit: <path d="M9 3.5H5.5A2 2 0 0 0 3.5 5.5V9M15 3.5h3.5a2 2 0 0 1 2 2V9M9 20.5H5.5a2 2 0 0 1-2-2V15M15 20.5h3.5a2 2 0 0 0 2-2V15" />,
  minus: <path d="M5 12h14" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  warning: (
    <>
      <path d="M12 3.5 21 19H3z" />
      <path d="M12 10v4M12 16.8h.01" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12.5" rx="2.5" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </>
  ),
  pulse: <path d="M3 12h4l2.5-6 4 12L16 12h5" />,
  brain: (
    <>
      <path d="M12 5.5a3 3 0 0 0-5.6-1.4A3 3 0 0 0 4 9.3a3.2 3.2 0 0 0 .6 5.3A3 3 0 0 0 9 19a3 3 0 0 0 3-2.4z" />
      <path d="M12 5.5a3 3 0 0 1 5.6-1.4A3 3 0 0 1 20 9.3a3.2 3.2 0 0 1-.6 5.3A3 3 0 0 1 15 19a3 3 0 0 1-3-2.4z" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  key: (
    <>
      <circle cx="8" cy="15.5" r="4.5" />
      <path d="m11.5 12.5 8-8M17 7l2 2M14.5 9.5l2 2" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-1.8 0-1.6-1.6-1.7-1.6-3 0-.9.7-1.7 1.9-1.7h1.7a4.5 4.5 0 0 0 4.5-4.5c0-3.4-3.8-6-8.5-6" />
      <path d="M7.5 11h.01M10 7.5h.01M14.5 7h.01" />
    </>
  ),
  webhook: (
    <>
      <path d="M9.5 8.5a3 3 0 1 1 4.3 2.7l2.7 4.8" />
      <path d="M17 12.5a3 3 0 1 1-1.6 5.5H9.9" />
      <path d="M9.5 20a3 3 0 1 1-2.6-4.5l2.8-5" />
    </>
  ),
  microphone: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
    </>
  ),
  paperclip: <path d="M8 13.5V8.2a4 4 0 0 1 8 0v7.3a3.2 3.2 0 0 1-6.4 0V9.4" />,
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m3.8 16.5 5.2-4.4 3.4 2.9 2.6-2.2 5.2 4.2" />
    </>
  ),
  film: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M8 5v14M16 5v14M3.5 9.5H8M3.5 14.5H8M16 9.5h4.5M16 14.5h4.5" />
    </>
  ),
  file: (
    <>
      <path d="M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13A2 2 0 0 0 7.5 20.5h9a2 2 0 0 0 2-2V9z" />
      <path d="M14 3.5V9h5.5" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  flow: (
    <>
      <rect x="3.5" y="3.5" width="6" height="5" rx="1.5" />
      <rect x="14.5" y="9.5" width="6" height="5" rx="1.5" />
      <rect x="3.5" y="15.5" width="6" height="5" rx="1.5" />
      <path d="M9.5 6H13a2 2 0 0 1 2 2v1.5M9.5 18H13a2 2 0 0 0 2-2v-1.5" />
    </>
  ),
  unlink: (
    <>
      <path d="M9.5 14.5 8 16a3.2 3.2 0 0 1-4.5-4.5L5 10" />
      <path d="M14.5 9.5 16 8a3.2 3.2 0 0 1 4.5 4.5L19 14" />
      <path d="m4 4 16 16" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className ?? ''}`}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * An icon-only control. The label is the accessible name and the tooltip both — an
 * icon button with neither is the single most common a11y failure in this app's chrome.
 */
export function IconButton({
  icon,
  label,
  onClick,
  active,
  size = 16,
  disabled,
  tone = 'quiet',
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  size?: number;
  disabled?: boolean;
  tone?: 'quiet' | 'raised' | 'accent';
}): ReactNode {
  const background = tone === 'accent' ? 'var(--color-accent)' : active ? 'var(--color-raised)' : tone === 'raised' ? 'var(--color-raised)' : 'transparent';
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      className="grid h-8 w-8 place-items-center rounded-lg disabled:opacity-40"
      style={{
        background,
        color: tone === 'accent' ? 'var(--color-accent-ink)' : active ? 'var(--color-ink)' : 'var(--color-ink-secondary)',
      }}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}
