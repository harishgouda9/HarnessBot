import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { harnessIdentity, rewriteTsSpecifiers, tsSpecifierRefs } from './bundle-server.mjs';

describe('bundle specifier rewrite', () => {
  it('rewrites static and dynamic .ts imports, including the grok hands turn', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'server', 'drivers', 'cli.ts'), 'utf8');
    const rewritten = rewriteTsSpecifiers(source);
    expect(rewritten).toContain("import('./acp.js')");
    expect(rewritten).toContain("import('./builtIn.js')");
    expect(rewritten).not.toContain("import('./acp.ts')");
    expect(rewritten).not.toContain("import('./builtIn.ts')");
    expect(tsSpecifierRefs(rewritten)).toEqual([]);
  });

  it('leaves a .ts mention that is not a module specifier alone', () => {
    const source = "const note = 'cli.ts';\nawait import('./acp.ts');\nimport { grokHandsArgs } from './builtIn.ts';\n";
    const rewritten = rewriteTsSpecifiers(source);
    expect(rewritten).toContain("const note = 'cli.ts';");
    expect(rewritten).toContain("await import('./acp.js');");
    expect(rewritten).toContain("from './builtIn.js';");
    expect(tsSpecifierRefs(rewritten)).toEqual([]);
  });

  it('writes a name-and-version stub the packaged server can walk up to', () => {
    const stub = JSON.parse(harnessIdentity('0.1.44'));
    expect(stub).toEqual({ name: 'harnessbot', version: '0.1.44' });
    expect(Object.keys(stub)).toEqual(['name', 'version']);
  });
});
