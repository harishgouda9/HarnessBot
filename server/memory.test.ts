import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig, publicConfig, saveConfig } from './config.ts';
import * as memory from './memory.ts';

/**
 * The four-tier memory model.
 *
 * Tier 1 is the active window and its maintenance (compaction, externalisation);
 * tiers 2 and 3 are durable structured memory at widening scope; tier 4 is the shared
 * filesystem every bot hands files through.
 */

describe('tier 2: durable memory across scopes', () => {
  it('reaches every bot from the account-wide tier', () => {
    memory.addMemory({
      scope: 'workspace',
      kind: 'preference',
      text: 'Ship dates are always written as ISO 8601.',
      source: 'user',
    });

    // No bot ever installed this, and no section was involved.
    expect(memory.memoryForPrompt('bot_never_seen_before')).toContain('ISO 8601');
  });

  it('ranks a bot own memory above the section and the workspace', () => {
    memory.addMemory({ scope: 'workspace', kind: 'fact', text: 'workspace-level belief', source: 'user' });
    memory.addMemory({ scope: 'section', sectionId: 'research', kind: 'fact', text: 'section-level belief', source: 'user' });
    memory.addMemory({ scope: 'bot', botId: 'bot_rank', kind: 'fact', text: 'bot-level belief', source: 'user' });

    const prompt = memory.memoryForPrompt('bot_rank', 'research');
    // A local correction has to outrank a general belief, or it never wins.
    expect(prompt.indexOf('bot-level belief')).toBeLessThan(prompt.indexOf('section-level belief'));
    expect(prompt.indexOf('section-level belief')).toBeLessThan(prompt.indexOf('workspace-level belief'));
  });

  it('refuses an unknown scope rather than quietly writing to the wrong tier', () => {
    expect(() => memory.addMemory({ scope: 'everyone' as never, kind: 'fact', text: 'x', source: 'user' })).toThrow(
      /unknown memory scope/,
    );
  });
});

describe('tier 4: shared artifacts', () => {
  it('round-trips a file every bot can reach', () => {
    memory.writeArtifact('handoff.csv', 'a,b\n1,2\n');
    expect(memory.readArtifact('handoff.csv')).toContain('a,b');
    expect(memory.listArtifacts().some((f) => f.name === 'handoff.csv')).toBe(true);

    memory.deleteArtifact('handoff.csv');
    expect(memory.listArtifacts().some((f) => f.name === 'handoff.csv')).toBe(false);
  });

  it('refuses a name that escapes the shared directory', () => {
    // The name arrives from a bot's tool call, so containment is checked, not assumed.
    expect(() => memory.artifactPath('../escaped.txt')).toThrow(/escapes/);
    expect(() => memory.artifactPath('../../.harnessbot/config.json')).toThrow(/escapes/);
    expect(() => memory.artifactPath('')).toThrow();
    // A nested path inside the directory is fine.
    expect(memory.artifactPath('runs/today.txt')).toContain('runs');
  });
});

describe('tier 1 maintenance', () => {
  it('spills an oversized line to disk and leaves a pointer', () => {
    const huge = 'x'.repeat(memory.EXTERNALISE_OVER + 5000);
    const result = memory.externalise(huge, 'scrape');

    expect(result.artifact).toBeTruthy();
    expect(result.text.length).toBeLessThan(huge.length);
    expect(result.text).toContain(result.artifact!);
    // The whole payload survives on disk; only the prompt copy is trimmed.
    expect(memory.readArtifact(result.artifact!)).toHaveLength(huge.length);
    memory.deleteArtifact(result.artifact!);
  });

  it('leaves an ordinary line completely alone', () => {
    const small = 'just a normal reply';
    expect(memory.externalise(small)).toEqual({ text: small });
  });

  it('compacts old turns into a digest instead of dropping them', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'bot') as 'user' | 'bot',
      text: i === 0 ? 'Audit the competitor pricing pages' : `turn ${i}`,
      name: i % 2 === 0 ? undefined : 'Research',
    }));

    const out = memory.compactTranscript(lines, 10);

    expect(out).toHaveLength(11); // one digest plus the kept window
    // The opening request is the context a long task most needs, and a hard slice ate it.
    expect(out[0]!.text).toContain('Audit the competitor pricing pages');
    expect(out[0]!.text).toContain('50 turns');
    expect(out[0]!.text).toContain('Research');
    expect(out.at(-1)!.text).toBe('turn 59');
  });

  it('does not touch a transcript that already fits', () => {
    const lines = [{ role: 'user' as const, text: 'hello' }];
    expect(memory.compactTranscript(lines, 40)).toEqual(lines);
  });
});

describe('config never echoes a credential', () => {
  it('replaces instance environment values with their names', () => {
    saveConfig({
      instances: {
        ...getConfig().instances,
        'custom-provider': { driver: 'openaiCompat', environment: { OPENAI_API_KEY: 'sk-must-not-be-echoed' } },
      },
    });

    const wire = JSON.stringify(publicConfig());
    // instances[].environment used to ride out on GET /api/config and the `config`
    // SSE event, which is exactly where a custom provider's key lives.
    expect(wire).not.toContain('sk-must-not-be-echoed');
    expect(publicConfig().instances['custom-provider']).toMatchObject({ environmentKeys: ['OPENAI_API_KEY'] });
    // The value is still there for the driver that needs it.
    expect(getConfig().instances['custom-provider']!.environment!.OPENAI_API_KEY).toBe('sk-must-not-be-echoed');
  });

  it('keeps secrets out too', () => {
    saveConfig({ secrets: { 'composio.apiKey': 'sk-secret-value' } });
    expect(JSON.stringify(publicConfig())).not.toContain('sk-secret-value');
    expect(publicConfig().configured['composio.apiKey']).toBe(true);
  });
});

describe('the shared directory stays inside the data dir', () => {
  it('never resolves to the user home or a project folder', () => {
    const dir = memory.sharedDir();
    expect(fs.existsSync(dir)).toBe(true);
    expect(path.resolve(dir)).toContain(path.resolve(process.env.HB_DATA_DIR!));
  });
});
