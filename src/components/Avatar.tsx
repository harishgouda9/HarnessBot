import type { BotActivity, HarnessbotColor } from '../../shared/types.ts';

/**
 * The roster is people-shaped, so a bot gets a face, not a generic robot glyph.
 * Expressions are role-aware and derived from activity — the mascot is the working
 * indicator, which is why the bubble does not need to stream tokens.
 */

const COLORS: Record<HarnessbotColor, string> = {
  green: '#2fa06a',
  blue: '#1084fe',
  red: '#e0453f',
  orange: '#e0742a',
  purple: '#8a5cf6',
  cyan: '#12a5c4',
  pink: '#e055a0',
  yellow: '#d1a017',
  teal: '#11897f',
  coral: '#e0685c',
};

export const botColor = (color: HarnessbotColor): string => COLORS[color] ?? COLORS.blue;

/** Older ten-face vocabulary still resolves, so saved expressions keep working. */
const LEGACY_FACES: Record<string, string> = {
  happy: 'idle',
  neutral: 'idle',
  focused: 'working',
  thinking: 'working',
  confused: 'waiting',
  surprised: 'waiting',
  sad: 'dead',
  angry: 'dead',
  sleepy: 'idle',
  excited: 'idle',
};

type Face = 'idle' | 'working' | 'waiting' | 'dead';

function faceFor(activity: BotActivity | undefined, expression?: string | null): Face {
  if (expression && LEGACY_FACES[expression]) return LEGACY_FACES[expression] as Face;
  if (activity === 'working') return 'working';
  if (activity === 'waiting-on-you' || activity === 'no-signal') return 'waiting';
  if (activity === 'dead') return 'dead';
  return 'idle';
}

export function Avatar({
  name,
  color,
  activity,
  expression,
  avatarUrl,
  size = 36,
}: {
  name: string;
  color: HarnessbotColor;
  activity?: BotActivity;
  expression?: string | null;
  avatarUrl?: string;
  size?: number;
}) {
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        width={size}
        height={size}
        className="rounded-xl object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }

  const face = faceFor(activity, expression);
  const fill = botColor(color);
  const eyeY = face === 'working' ? 15 : 14;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      role="img"
      aria-label={name}
      className="shrink-0"
      style={{ borderRadius: size / 3.6 }}
    >
      <rect width="36" height="36" rx="10" fill={fill} />
      {face === 'working' ? (
        <>
          <rect x="9" y={eyeY} width="6" height="2.4" rx="1.2" fill="#fff" />
          <rect x="21" y={eyeY} width="6" height="2.4" rx="1.2" fill="#fff" />
        </>
      ) : face === 'dead' ? (
        <>
          <path d="M9.5 12.5 L14.5 17.5 M14.5 12.5 L9.5 17.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
          <path d="M21.5 12.5 L26.5 17.5 M26.5 12.5 L21.5 17.5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="12" cy={eyeY} r={face === 'waiting' ? 3.4 : 2.8} fill="#fff" />
          <circle cx="24" cy={eyeY} r={face === 'waiting' ? 3.4 : 2.8} fill="#fff" />
        </>
      )}
      {face === 'waiting' ? (
        <circle cx="18" cy="25" r="2.6" fill="#fff" opacity="0.95" />
      ) : (
        <path
          d={face === 'dead' ? 'M12 26 Q18 22 24 26' : 'M12 23 Q18 28 24 23'}
          stroke="#fff"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/** Presence dot. Colour is never the only signal — every caller pairs it with text. */
export function ActivityDot({ activity }: { activity?: BotActivity }) {
  if (!activity || activity === 'idle') return null;
  const map: Record<string, { color: string; label: string }> = {
    working: { color: 'var(--color-accent)', label: 'Working' },
    'waiting-on-you': { color: 'var(--color-warning)', label: 'Waiting on you' },
    'no-signal': { color: 'var(--color-warning)', label: 'No signal' },
    dead: { color: 'var(--color-danger)', label: 'Needs setup' },
  };
  const item = map[activity];
  if (!item) return null;
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full ${activity === 'working' ? 'status-pulse' : ''}`}
      style={{ background: item.color }}
      title={item.label}
      aria-label={item.label}
    />
  );
}
