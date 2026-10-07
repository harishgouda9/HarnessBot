import { useId } from 'react';
import { isAvatarShape, type AvatarShape, type BotActivity, type HarnessbotColor } from '../../shared/types.ts';

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

/** Six petals around a face-sized centre. Built once; the clip path reuses it. */
const FLOWER_PETALS = [0, 60, 120, 180, 240, 300].map((deg) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { cx: 18 + Math.cos(rad) * 9.2, cy: 18 + Math.sin(rad) * 9.2 };
});

/**
 * How far to raise the mascot so the eyes and mouth stay inside a shape that
 * narrows away from the middle of the 36×36 box. Geometric shapes use 0.
 */
function faceLift(shape: AvatarShape): number {
  if (shape === 'heart') return 3.2;
  if (shape === 'drop') return 2.4;
  if (shape === 'puff') return 1.6;
  if (shape === 'mochi') return -3.2;
  if (shape === 'block') return -1.6;
  if (shape === 'bun') return -2.4;
  return 0;
}

function isClay(shape: AvatarShape): shape is 'puff' | 'block' | 'mochi' | 'bun' {
  return shape === 'puff' || shape === 'block' || shape === 'mochi' || shape === 'bun';
}

/** Mix `from` toward `to`. `t` is 0–1. */
function mixHex(from: string, to: string, t: number): string {
  const pick = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const mixed = [0, 1, 2].map((index) => Math.round(pick(from, index) + (pick(to, index) - pick(from, index)) * t));
  return `#${mixed.map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

const PUFF = { cx: 18, cy: 16.6, r: 13.8 };
const BUN_HEAD = { cx: 18, cy: 20.4, r: 13.2 };
const MOCHI = { x: 2.2, y: 13.4, w: 31.6, h: 20.2, r: 10.1 };
const BLOCK = { x: 7.2, y: 11.2, w: 21, h: 20.2 };
const BLOCK_DEPTH = { x: 4.8, y: 5 };

/** Clip path for one silhouette, in the 36×36 avatar box. */
function AvatarSilhouette({ shape }: { shape: AvatarShape }) {
  switch (shape) {
    case 'rounded':
      return <rect width="36" height="36" rx="10" />;
    case 'circle':
      return <circle cx="18" cy="18" r="18" />;
    case 'square':
      return <rect width="36" height="36" />;
    case 'hexagon':
      return <polygon points="18,1.5 32.3,9.8 32.3,26.3 18,34.5 3.7,26.3 3.7,9.8" />;
    case 'diamond':
      return <polygon points="18,1.2 34.8,18 18,34.8 1.2,18" />;
    case 'shield':
      return <path d="M18 1.2 L33.2 7.2 V18.4 C33.2 26.2 26.8 31.4 18 34.6 C9.2 31.4 2.8 26.2 2.8 18.4 V7.2 Z" />;
    case 'pill':
      return <rect x="7" y="1" width="22" height="34" rx="11" />;
    case 'oval':
      return <ellipse cx="18" cy="18" rx="14.5" ry="17.4" />;
    case 'arch':
      return <path d="M2.2 34.6 H33.8 V17 A15.8 15.8 0 0 0 2.2 17 Z" />;
    case 'cat':
      return (
        <>
          <circle cx="18" cy="20.2" r="14.4" />
          <polygon points="6.2,12.5 2.2,1.4 14.2,8.2" />
          <polygon points="29.8,12.5 33.8,1.4 21.8,8.2" />
        </>
      );
    case 'heart':
      return (
        <path d="M18 34.2 C7.2 26.4 2 21.2 2 14.4 C2 8.2 6.6 4.4 11.6 6.6 C14.4 7.8 16.6 10.4 18 13 C19.4 10.4 21.6 7.8 24.4 6.6 C29.4 4.4 34 8.2 34 14.4 C34 21.2 28.8 26.4 18 34.2 Z" />
      );
    case 'flower':
      return (
        <>
          <circle cx="18" cy="18" r="12.2" />
          {FLOWER_PETALS.map((petal) => (
            <circle key={`${petal.cx}-${petal.cy}`} cx={petal.cx} cy={petal.cy} r="7.4" />
          ))}
        </>
      );
    case 'drop':
      return (
        <path d="M18 34.6 C8.4 28.2 3 23.4 3 15.6 C3 8 9.4 2.2 18 2.2 C26.6 2.2 33 8 33 15.6 C33 23.4 27.6 28.2 18 34.6 Z" />
      );
    case 'puff':
      return <circle cx={PUFF.cx} cy={PUFF.cy} r={PUFF.r} />;
    case 'block':
      return <rect x={BLOCK.x} y={BLOCK.y} width={BLOCK.w} height={BLOCK.h} rx="1.4" />;
    case 'mochi':
      return <rect x={MOCHI.x} y={MOCHI.y} width={MOCHI.w} height={MOCHI.h} rx={MOCHI.r} />;
    case 'bun':
      return (
        <>
          <circle cx="10" cy="9.2" r="5.4" />
          <circle cx="26" cy="9.2" r="5.4" />
          <circle cx={BUN_HEAD.cx} cy={BUN_HEAD.cy} r={BUN_HEAD.r} />
        </>
      );
  }
}

function FaceMarks({ face, eyeY, clay }: { face: Face; eyeY: number; clay?: boolean }) {
  return (
    <>
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
          {clay ? (
            <>
              <circle cx="12.85" cy={eyeY + 0.4} r={face === 'waiting' ? 1.3 : 1.15} fill="#2a2340" />
              <circle cx="24.85" cy={eyeY + 0.4} r={face === 'waiting' ? 1.3 : 1.15} fill="#2a2340" />
              <circle cx="11.65" cy={eyeY - 0.8} r="0.48" fill="#fff" />
              <circle cx="23.65" cy={eyeY - 0.8} r="0.48" fill="#fff" />
            </>
          ) : null}
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
      {clay && face !== 'dead' && face !== 'working' ? (
        <>
          <ellipse cx="8.4" cy={eyeY + 4.6} rx="2.15" ry="1.15" fill="#ffb7c8" />
          <ellipse cx="27.6" cy={eyeY + 4.6} rx="2.15" ry="1.15" fill="#ffb7c8" />
        </>
      ) : null}
    </>
  );
}

function ClayShape({
  shape,
  fill,
  gid,
  avatarUrl,
  face,
  eyeY,
  lift,
}: {
  shape: 'puff' | 'block' | 'mochi' | 'bun';
  fill: string;
  gid: string;
  avatarUrl?: string;
  face: Face;
  eyeY: number;
  lift: number;
}) {
  const light = mixHex(fill, '#ffffff', 0.5);
  const dark = mixHex(fill, '#241838', 0.38);
  const bodyId = `${gid}-body`;
  const shineId = `${gid}-shine`;
  const clipId = `${gid}-clay`;
  const right = BLOCK.x + BLOCK.w;
  const bottom = BLOCK.y + BLOCK.h;
  const top = `M${BLOCK.x} ${BLOCK.y} L${BLOCK.x + BLOCK_DEPTH.x} ${BLOCK.y - BLOCK_DEPTH.y} L${right + BLOCK_DEPTH.x} ${BLOCK.y - BLOCK_DEPTH.y} L${right} ${BLOCK.y} Z`;
  const side = `M${right} ${BLOCK.y} L${right + BLOCK_DEPTH.x} ${BLOCK.y - BLOCK_DEPTH.y} L${right + BLOCK_DEPTH.x} ${bottom - BLOCK_DEPTH.y} L${right} ${bottom} Z`;

  return (
    <>
      <defs>
        <radialGradient id={bodyId} cx="32%" cy="28%" r="78%">
          <stop offset="0%" stopColor={light} />
          <stop offset="54%" stopColor={fill} />
          <stop offset="100%" stopColor={dark} />
        </radialGradient>
        <radialGradient id={shineId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <clipPath id={clipId}>
          {shape === 'bun' ? <circle cx={BUN_HEAD.cx} cy={BUN_HEAD.cy} r={BUN_HEAD.r} /> : <AvatarSilhouette shape={shape} />}
        </clipPath>
      </defs>
      <ellipse cx="18" cy="33.5" rx={shape === 'block' ? 12 : 10} ry="1.8" fill="#000" opacity="0.16" />
      {shape === 'bun' ? (
        <>
          <circle cx="10" cy="9.2" r="5.4" fill={`url(#${bodyId})`} />
          <circle cx="26" cy="9.2" r="5.4" fill={`url(#${bodyId})`} />
          <circle cx="10" cy="9.6" r="2.6" fill="#fff" opacity="0.7" />
          <circle cx="26" cy="9.6" r="2.6" fill="#fff" opacity="0.7" />
        </>
      ) : null}
      {shape === 'block' ? (
        <>
          <path d={side} fill={dark} />
          <path d={top} fill={light} />
          <path d="M16 8.1 H24" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.3" strokeLinecap="round" />
        </>
      ) : null}
      {avatarUrl ? (
        <g clipPath={`url(#${clipId})`}>
          <image href={avatarUrl} width="36" height="36" preserveAspectRatio="xMidYMid slice" />
        </g>
      ) : shape === 'block' ? (
        <rect x={BLOCK.x} y={BLOCK.y} width={BLOCK.w} height={BLOCK.h} rx="1.4" fill={fill} />
      ) : shape === 'bun' ? (
        <circle cx={BUN_HEAD.cx} cy={BUN_HEAD.cy} r={BUN_HEAD.r} fill={`url(#${bodyId})`} />
      ) : (
        <g fill={`url(#${bodyId})`}>
          <AvatarSilhouette shape={shape} />
        </g>
      )}
      {shape === 'block' && !avatarUrl ? (
        <path d={`M${BLOCK.x + 1.6} ${BLOCK.y + 0.7} H${right - 1.4}`} stroke="#fff" strokeOpacity="0.45" strokeWidth="1.1" strokeLinecap="round" />
      ) : null}
      {shape === 'puff' ? (
        <ellipse cx="12.4" cy="9.4" rx="5" ry="2.8" fill={`url(#${shineId})`} transform="rotate(-30 12.4 9.4)" />
      ) : null}
      {shape === 'mochi' ? (
        <ellipse cx="11" cy="18.2" rx="4.4" ry="2.1" fill={`url(#${shineId})`} transform="rotate(-12 11 18.2)" />
      ) : null}
      {shape === 'bun' ? (
        <ellipse cx="13.2" cy="13.4" rx="4.4" ry="2.5" fill={`url(#${shineId})`} transform="rotate(-26 13.2 13.4)" />
      ) : null}
      {avatarUrl ? null : (
        <g clipPath={`url(#${clipId})`}>
          <g transform={lift ? `translate(0 ${-lift})` : undefined}>
            <FaceMarks face={face} eyeY={eyeY} clay />
          </g>
        </g>
      )}
    </>
  );
}

export function Avatar({
  name,
  color,
  activity,
  expression,
  avatarUrl,
  avatarShape,
  size = 36,
  decorative = false,
}: {
  name: string;
  color: HarnessbotColor;
  activity?: BotActivity;
  expression?: string | null;
  avatarUrl?: string;
  avatarShape?: AvatarShape | null;
  size?: number;
  /** Inside a button that already names the shape. */
  decorative?: boolean;
}) {
  const clipId = `hb-av-${useId().replace(/:/g, '')}`;
  const shape: AvatarShape = isAvatarShape(avatarShape) ? avatarShape : 'rounded';
  const face = faceFor(activity, expression);
  const fill = botColor(color);
  const eyeY = face === 'working' ? 15 : 14;
  const lift = faceLift(shape);

  if (isClay(shape)) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 36 36"
        role={decorative ? undefined : 'img'}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
        className="shrink-0"
      >
        <ClayShape shape={shape} fill={fill} gid={clipId} avatarUrl={avatarUrl} face={face} eyeY={eyeY} lift={lift} />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
      className="shrink-0"
    >
      <defs>
        <clipPath id={clipId}>
          <AvatarSilhouette shape={shape} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {avatarUrl ? (
          <image href={avatarUrl} width="36" height="36" preserveAspectRatio="xMidYMid slice" />
        ) : (
          <>
            <rect width="36" height="36" fill={fill} />
            <g transform={lift ? `translate(0 ${-lift})` : undefined}>
              <FaceMarks face={face} eyeY={eyeY} />
            </g>
          </>
        )}
      </g>
    </svg>
  );
}

/** Presence dot. Colour is never the only signal — every caller pairs it with text. */
export function ActivityDot({ activity }: { activity?: BotActivity }) {
  if (!activity || activity === 'idle') return null;
  const map: Record<string, { color: string; label: string }> = {
    working: { color: 'var(--color-success)', label: 'Working' },
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
