import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeStatus, bridgedMcpServers, hermesSkillFiles, mergeMcpServers, resetBridgeCache } from './hermes-bridge.ts';
import type { McpServerRecord } from '../shared/types.ts';

/**
 * The bridge decides what a host Hermes may lend a bot, so the cases that matter
 * are the refusals: nothing arrives switched on, and the user's own servers are
 * never touched by a refresh.
 */

const roots: string[] = [];

function withManifest(manifest: unknown): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bridge-'));
  roots.push(dir);
  const file = path.join(dir, 'hermes-bridge.json');
  fs.writeFileSync(file, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  process.env.HB_HERMES_BRIDGE = file;
  resetBridgeCache();
}

function withSkillsTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-skills-'));
  roots.push(root);
  // Hermes files skills one category deep; HarnessBot's own library is flat.
  fs.mkdirSync(path.join(root, 'devops', 'deploy-thing'), { recursive: true });
  fs.writeFileSync(path.join(root, 'devops', 'deploy-thing', 'SKILL.md'), '---\nname: deploy-thing\n---\nDeploys.');
  fs.mkdirSync(path.join(root, 'flat-skill'), { recursive: true });
  fs.writeFileSync(path.join(root, 'flat-skill', 'SKILL.md'), 'A flat one.');
  fs.writeFileSync(path.join(root, 'not-a-skill.txt'), 'ignored');
  return root;
}

afterEach(() => {
  delete process.env.HB_HERMES_BRIDGE;
  resetBridgeCache();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the bridge when there is no host', () => {
  it('reports itself absent rather than failing', () => {
    resetBridgeCache();
    expect(bridgeStatus()).toEqual({ connected: false, mcpServers: 0, skills: 0 });
    expect(bridgedMcpServers()).toEqual([]);
    expect(hermesSkillFiles()).toEqual([]);
  });

  it('treats a malformed manifest as no host', () => {
    withManifest('{ not json');
    expect(bridgeStatus().connected).toBe(false);
  });
});

describe('imported MCP servers', () => {
  it('arrive switched off, whatever the manifest claims', () => {
    withManifest({
      version: 1,
      mcpServers: [{ name: 'hermes/github', enabled: true, transport: 'stdio', command: 'gh-mcp' }],
    });
    expect(bridgedMcpServers()).toEqual([
      { name: 'hermes/github', enabled: false, transport: 'stdio', command: 'gh-mcp' },
    ]);
  });

  it('ignores entries that are not namespaced to the host', () => {
    withManifest({
      version: 1,
      mcpServers: [
        { name: 'sneaky', enabled: false, transport: 'stdio', command: 'x' },
        { name: 'hermes/ok', enabled: false, transport: 'stdio', command: 'y' },
      ],
    });
    expect(bridgedMcpServers().map((s) => s.name)).toEqual(['hermes/ok']);
  });
});

describe('merging into the stored list', () => {
  const own: McpServerRecord = { name: 'my-own', enabled: true, transport: 'stdio', command: 'mine' };

  it('leaves the user\'s own servers exactly as they were', () => {
    withManifest({ version: 1, mcpServers: [{ name: 'hermes/a', enabled: false, transport: 'stdio', command: 'a' }] });
    const merged = mergeMcpServers([own]);
    expect(merged.find((s) => s.name === 'my-own')).toEqual(own);
  });

  it('keeps the switch the user set, while refreshing the definition', () => {
    withManifest({ version: 1, mcpServers: [{ name: 'hermes/a', enabled: false, transport: 'stdio', command: 'NEW' }] });
    const stored: McpServerRecord[] = [
      own,
      { name: 'hermes/a', enabled: true, transport: 'stdio', command: 'OLD' },
    ];
    const merged = mergeMcpServers(stored);
    const imported = merged.find((s) => s.name === 'hermes/a')!;
    expect(imported.enabled).toBe(true); // the user turned it on
    expect(imported.command).toBe('NEW'); // Hermes moved it
  });

  it('drops an import the host no longer has', () => {
    withManifest({ version: 1, mcpServers: [] });
    const merged = mergeMcpServers([own, { name: 'hermes/gone', enabled: true, transport: 'stdio', command: 'x' }]);
    expect(merged.map((s) => s.name)).toEqual(['my-own']);
  });

  it('is a no-op with no host, so standalone config round-trips', () => {
    resetBridgeCache();
    expect(mergeMcpServers([own])).toEqual([own]);
  });
});

describe('host skills', () => {
  it('finds SKILL.md at either depth and ignores everything else', () => {
    const root = withSkillsTree();
    withManifest({ version: 1, skillsRoot: root, mcpServers: [] });
    const names = hermesSkillFiles().map((s) => s.name).sort();
    expect(names).toEqual(['deploy-thing', 'flat-skill']);
    expect(hermesSkillFiles().find((s) => s.name === 'flat-skill')!.body).toContain('A flat one.');
  });

  it('counts them in the status the UI reads', () => {
    const root = withSkillsTree();
    withManifest({ version: 1, profile: 'default', skillsRoot: root, mcpServers: [] });
    expect(bridgeStatus()).toMatchObject({ connected: true, profile: 'default', skills: 2, mcpServers: 0 });
  });
});
