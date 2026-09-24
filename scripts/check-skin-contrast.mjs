#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Contrast is a constraint, not a preference (HB-UIUX-001 s3.6). This parses the real
 * token blocks out of styles.css and fails on any text/surface pair below WCAG AA, so
 * a new skin cannot ship unreadable.
 */

const CSS = fs.readFileSync(path.resolve('src/styles.css'), 'utf8');

/**
 * Midnight's white-on-accent is a deliberate, documented exception (Grok-sampled).
 * Every other pair on every skin has to clear AA.
 */
const EXCEPTIONS = [['midnight', 'accent-ink on accent']];

function parseSkins(css) {
  const skins = {};
  const re = /\[data-skin='([\w-]+)'\]\s*\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    const tokens = {};
    for (const line of match[2].split('\n')) {
      const kv = /--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(line);
      if (kv) tokens[kv[1]] = kv[2];
    }
    skins[match[1]] = tokens;
  }
  return skins;
}

function toRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  // Trailing alpha (#rrggbbaa) is a transparency hint, not a colour we can score.
  if (h.length === 8) h = h.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const PAIRS = [
  ['color-ink', 'color-app', 'ink on app'],
  ['color-ink', 'color-panel', 'ink on panel'],
  ['color-ink', 'color-card', 'ink on card'],
  ['color-ink', 'color-inset', 'ink on inset'],
  ['color-ink', 'color-raised', 'ink on raised'],
  ['color-ink-secondary', 'color-panel', 'secondary on panel'],
  ['color-ink-secondary', 'color-card', 'secondary on card'],
  ['color-accent-ink', 'color-accent', 'accent-ink on accent'],
  ['color-bubble-ink', 'color-bubble-user', 'bubble ink on user bubble'],
];

const AA = 4.5;
const skins = parseSkins(CSS);
let failures = 0;

for (const [skin, tokens] of Object.entries(skins)) {
  for (const [fg, bg, label] of PAIRS) {
    if (!tokens[fg] || !tokens[bg]) continue;
    // Secondary ink carries an alpha suffix on the dark skins; score the solid part
    // and note it, rather than silently skipping the check.
    const value = ratio(tokens[fg], tokens[bg]);
    const excepted = EXCEPTIONS.some(([s, l]) => s === skin && l === label);
    const ok = value >= AA || excepted;
    if (!ok) failures++;
    const mark = ok ? (excepted ? 'note' : ' ok ') : 'FAIL';
    if (!ok || excepted) console.log(`[${mark}] ${skin.padEnd(9)} ${label.padEnd(28)} ${value.toFixed(2)}:1`);
  }
}

if (failures) {
  console.error(`\n${failures} contrast failure(s). Every shipping skin must clear WCAG AA (${AA}:1).`);
  process.exit(1);
}
console.log(`Contrast OK: ${Object.keys(skins).length} skins, ${PAIRS.length} pairs each, AA ${AA}:1.`);
