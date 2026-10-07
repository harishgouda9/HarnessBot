#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Compile the harness for packaging. TypeScript here is types-only (no enums, no
 * decorators, no parameter properties), so "compiling" is stripping types — which
 * keeps the packaged server a plain set of .js files with zero runtime dependencies.
 *
 * Every spawnable entry point must be listed below AND in proxy-paths. Incident 0.1.24
 * was an unbundled import that killed packaged launch while /api/health stayed green.
 * Static `from '….ts'` and dynamic `import('….ts')` both have to become `.js`, because
 * dist-server only contains the emitted JavaScript.
 */

const ENTRY_POINTS = ['server/index.ts'];
const SPAWNED_PROXIES = ['server/mcp/agents-proxy.mjs', 'server/mcp/computer-driver.mjs', 'server/mcp/computer-win.ps1', 'scripts/mcp-server.mjs'];

/** `from './file.ts'` and `import('./file.ts')` → the `.js` file this script emits. */
export function rewriteTsSpecifiers(source) {
  return source
    .replace(/(from\s+['"][^'"]+)\.ts(['"])/g, '$1.js$2')
    .replace(/(import\s*\(\s*['"][^'"]+)\.ts(['"])/g, '$1.js$2');
}

/** Name and version only. The packaged server walks up to this file for /api/health. */
export function harnessIdentity(version) {
  return `${JSON.stringify({ name: 'harnessbot', version }, null, 2)}\n`;
}

/** Specifiers that still point at a TypeScript file. Comments that mention `.ts` are ignored. */
export function tsSpecifierRefs(source) {
  const refs = [];
  const pattern = /(?:from\s+|import\s*\(\s*)['"]([^'"]+\.ts)['"]/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    refs.push(match[1]);
  }
  return refs;
}

async function main() {
  const { stripTypeScriptTypes } = await import('node:module');
  const OUT = 'dist-server';
  fs.rmSync(OUT, { recursive: true, force: true });

  function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else out.push(full);
    }
    return out;
  }

  let count = 0;
  for (const root of ['server', 'shared']) {
    for (const file of walk(root)) {
      // Tests never ship.
      if (file.endsWith('.test.ts')) continue;
      const target = path.join(OUT, path.relative('.', file)).replace(/\.ts$/, '.js');
      fs.mkdirSync(path.dirname(target), { recursive: true });

      if (file.endsWith('.ts')) {
        const source = fs.readFileSync(file, 'utf8');
        const stripped = stripTypeScriptTypes(source, { mode: 'strip', sourceMap: false });
        fs.writeFileSync(target, rewriteTsSpecifiers(stripped), 'utf8');
      } else {
        fs.copyFileSync(file, target);
      }
      count++;
    }
  }

  // Spawned proxies live outside server/, so copy them in explicitly. Forgetting one is
  // exactly how a packaged build boots green and then dies the first time a bot uses it.
  for (const proxy of SPAWNED_PROXIES) {
    const target = path.join(OUT, proxy);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(proxy, target);
    count++;
  }

  const missing = [...ENTRY_POINTS, ...SPAWNED_PROXIES].filter(
    (entry) => !fs.existsSync(path.join(OUT, entry.replace(/\.ts$/, '.js'))),
  );
  if (missing.length) {
    console.error(`Entry points missing from the bundle: ${missing.join(', ')}`);
    process.exit(1);
  }

  const leftover = [];
  for (const file of walk(OUT)) {
    if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
    const refs = tsSpecifierRefs(fs.readFileSync(file, 'utf8'));
    if (refs.length) leftover.push(`${file}: ${refs.join(', ')}`);
  }
  if (leftover.length) {
    console.error(`Bundle still imports TypeScript files:\n${leftover.join('\n')}`);
    process.exit(1);
  }

  const rootPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  fs.writeFileSync(path.join(OUT, 'package.json'), harnessIdentity(rootPkg.version));

  console.log(`Bundled ${count} files into ${OUT}/`);
  console.log(`Entry points verified: ${[...ENTRY_POINTS, ...SPAWNED_PROXIES].join(', ')}`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  await main();
}
