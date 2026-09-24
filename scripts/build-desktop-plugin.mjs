#!/usr/bin/env node
/**
 * Compile the native Hermes desktop plugin.
 *
 * A disk plugin is loaded **uncompiled**: the runtime rewrites its import
 * specifiers, shims them to blob URLs and imports the result. That means JSX
 * syntax never parses, and only three specifiers resolve — `@hermes/plugin-sdk`,
 * `react` and `react/jsx-runtime`. Anything else is an up-front load error.
 *
 * So the source is ordinary TSX and this turns it into the form the loader
 * accepts: one ESM file, JSX compiled to `jsx()` calls against the automatic
 * runtime, those three specifiers left external, everything else bundled in.
 *
 * The checks at the end are the point. A bundle that imports a fourth specifier
 * fails at load with a message about the plugin, not about the import, so it is
 * worth refusing to ship one.
 */

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'integrations', 'hermes', 'desktop', 'src', 'plugin.tsx');
const OUT = path.join(ROOT, 'integrations', 'hermes', 'desktop', 'plugin.js');

/** Exactly what the runtime loader can resolve. */
export const ALLOWED_IMPORTS = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime']);

/** Every `from '…'` in a compiled ESM bundle, at module scope. */
export function importedSpecifiers(code) {
  const found = new Set();
  const pattern = /(?:^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(pattern)) found.add(match[1] ?? match[2]);
  return found;
}

/** JSX that survived compilation would fail to parse at load. */
export function looksLikeJsx(code) {
  // A compiled bundle still contains `<` in comparisons and generics, so look for
  // the shape that only JSX produces: a tag opening on an identifier or a close.
  return /<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*\s[^>]*\/>/.test(code);
}

export async function build({ silent = false } = {}) {
  const log = (...args) => {
    if (!silent) console.log(...args);
  };

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'react',
    jsxDev: false,
    external: [...ALLOWED_IMPORTS],
    legalComments: 'none',
    // Readable on purpose: this file is evaluated in the app's renderer realm
    // with full authority, and a reviewer should be able to read what it does.
    minify: false,
    write: true,
    logLevel: 'silent',
  });

  for (const warning of result.warnings) log(`  warning: ${warning.text}`);

  const code = fs.readFileSync(OUT, 'utf8');

  const specifiers = importedSpecifiers(code);
  const forbidden = [...specifiers].filter((s) => !ALLOWED_IMPORTS.has(s));
  if (forbidden.length) {
    throw new Error(
      `the desktop plugin imports specifiers the loader cannot resolve: ${forbidden.join(', ')}. ` +
        'Bundle them, or use one of ' + [...ALLOWED_IMPORTS].join(', '),
    );
  }

  if (looksLikeJsx(code)) throw new Error('the compiled plugin still contains JSX syntax; it would not parse at load');

  if (!/export\s*\{[^}]*\bplugin_default\b|export\s+default/.test(code)) {
    throw new Error('the compiled plugin has no default export; Hermes would load nothing');
  }

  const bytes = fs.statSync(OUT).size;
  log(`     -> ${path.relative(ROOT, OUT)} (${(bytes / 1024).toFixed(1)} kB)`);
  log(`     imports: ${[...specifiers].join(', ') || 'none'}`);
  return { out: OUT, bytes, specifiers: [...specifiers] };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-desktop-plugin.mjs')) {
  build().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
