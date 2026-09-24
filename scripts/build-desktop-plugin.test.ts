import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error - plain .mjs build script, no types
import { ALLOWED_IMPORTS, importedSpecifiers, looksLikeJsx } from './build-desktop-plugin.mjs';

/**
 * A disk plugin is evaluated uncompiled in the renderer, and only three import
 * specifiers resolve. A bundle that breaks either rule fails at load with a
 * message about the plugin rather than the cause, so the build refuses to ship
 * one — and these are the checks it refuses with.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILT = path.join(ROOT, 'integrations', 'hermes', 'desktop', 'plugin.js');

describe('importedSpecifiers', () => {
  it('finds named and bare imports', () => {
    const code = "import { a } from 'react';\nimport 'side-effect';\n";
    expect([...importedSpecifiers(code)].sort()).toEqual(['react', 'side-effect']);
  });

  it('finds a multi-line import list', () => {
    const code = "import {\n  Button,\n  Input,\n} from '@hermes/plugin-sdk';\n";
    expect([...importedSpecifiers(code)]).toEqual(['@hermes/plugin-sdk']);
  });

  it('does not mistake a string mentioning import for one', () => {
    expect([...importedSpecifiers("const help = 'run import from the menu';\n")]).toEqual([]);
  });
});

describe('looksLikeJsx', () => {
  it('catches a closing tag and a self-closing component', () => {
    expect(looksLikeJsx('const a = <div>hi</div>;')).toBe(true);
    expect(looksLikeJsx('const a = <Button label="x" />;')).toBe(true);
  });

  it('accepts compiled output that only compares numbers', () => {
    expect(looksLikeJsx('if (a < b && c > d) return jsx(Button, {});')).toBe(false);
  });

  it('accepts the jsx() call form the loader needs', () => {
    expect(looksLikeJsx('return jsxs("div", { children: [jsx(Row, {})] });')).toBe(false);
  });
});

describe('the shipped bundle', () => {
  it('exists, and imports only what the loader can resolve', () => {
    // Built by `npm run build:hermes-plugin`; a stale checkout is a real failure.
    expect(fs.existsSync(BUILT)).toBe(true);
    const code = fs.readFileSync(BUILT, 'utf8');

    for (const specifier of importedSpecifiers(code)) {
      expect(ALLOWED_IMPORTS.has(specifier)).toBe(true);
    }
    expect(looksLikeJsx(code)).toBe(false);
    expect(code).toMatch(/as default/);
  });

  it('mounts the full product plus the two Hermes chrome slots (Kanban row, SESSIONS tab)', () => {
    const code = fs.readFileSync(BUILT, 'utf8');
    expect(code).toContain('iframe');
    expect(code).not.toContain('formatAgo');
    expect(code).toMatch(/id:\s*["']page["']/);
    expect(code).toMatch(/id:\s*["']nav["']/);
    expect(code).toMatch(/id:\s*["']pane["']/);
    expect(code).toContain('SIDEBAR_NAV_AREA');
    expect(code).toContain('PANES_AREA');
    expect(code).toContain('sessions');
    expect(code).toContain('HarnessBot');
  });
});
