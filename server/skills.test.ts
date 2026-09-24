import { describe, expect, it } from 'vitest';
import { getConfig, saveConfig } from './config.ts';
import * as plugins from './plugins.ts';
import * as skills from './skills.ts';

const install = (scope: string, name: string, body: string): void => {
  const staged = skills.stageSkill(scope, name, '', body);
  skills.confirmSkill(scope, staged.name, staged.sha256);
};

describe('skill scopes', () => {
  it('lets a global skill reach a bot that never installed it', () => {
    install(skills.GLOBAL_SCOPE, 'house-style', '# House style\n\nAlways use metric.');
    const prompt = skills.skillsForPrompt('bot_alpha');
    expect(prompt).toContain('house-style');
  });

  it('lets a bot override a global skill of the same name', () => {
    install(skills.GLOBAL_SCOPE, 'deploy', '# Deploy\n\nThe workspace default.');
    install('bot_beta', 'deploy', '# Deploy\n\nBeta does it differently.');

    const effective = skills.effectiveSkills('bot_beta');
    // One entry, not two: the bot's own wins rather than both being offered.
    expect(effective.filter((s) => s.name === 'deploy')).toHaveLength(1);
    expect(effective.find((s) => s.name === 'deploy')!.body).toContain('Beta does it differently');
  });

  it('refuses a scope that would escape the data directory', () => {
    // The scope reaches this code from the client and becomes a directory name.
    expect(() => skills.scopeId('../../etc')).toThrow(/invalid skill scope/);
    expect(() => skills.scopeId('a/b')).toThrow(/invalid skill scope/);
    expect(skills.scopeId('bot_abc123')).toBe('bot_abc123');
  });
});

describe('reading a SKILL.md', () => {
  it('prefers frontmatter over the first prose line', () => {
    const meta = skills.summarize('---\nname: web-research\ndescription: Turn a question into a sourced answer.\n---\n\n# Web Research\n\nBody.');
    expect(meta.name).toBe('web-research');
    expect(meta.summary).toBe('Turn a question into a sourced answer.');
  });

  it('falls back to the first prose line when there is no frontmatter', () => {
    expect(skills.summarize('# Title\n\nWhat it does.\n').summary).toBe('What it does.');
  });

  it('turns a github blob url into a raw url', () => {
    expect(skills.rawUrlFor('https://github.com/o/r/blob/main/skills/foo/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/o/r/main/skills/foo/SKILL.md',
    );
    // Anything already raw is left alone.
    expect(skills.rawUrlFor('https://example.com/SKILL.md')).toBe('https://example.com/SKILL.md');
    expect(() => skills.rawUrlFor('http://example.com/SKILL.md')).toThrow(/https/);
  });

  it('names a skill after its folder, not after SKILL.md', () => {
    expect(skills.slugFromPath('skills/web-research/SKILL.md')).toBe('web-research');
    expect(skills.slugFromPath('https://example.com/My Skill.md')).toBe('my-skill');
  });
});

describe('recording a skill', () => {
  it('stages the draft for the bot that was recorded, and does not install it', () => {
    const session = skills.startRecording('bot_rec', 'deploy-check');
    skills.importSteps(session.id, ['run the checks', 'run the checks']);
    skills.addStep(session.id, 'check', 'the site answers');
    const staged = skills.finishRecording(session.id, 'Verify a deploy');
    expect(staged?.name).toBe('deploy-check');
    expect(staged?.body).toContain('run the checks');
    expect(skills.listStaged('bot_rec').some((skill) => skill.name === 'deploy-check')).toBe(true);
    expect(skills.listSkills('bot_rec').some((skill) => skill.name === 'deploy-check')).toBe(false);
    expect(skills.getRecording(session.id)).toBeUndefined();
  });
});

describe('built-in skills', () => {
  it('ships computer use and the phone skill as pre-built, and leaves research as a normal library skill', () => {
    const library = skills.librarySkills();
    expect(library.find((skill) => skill.name === 'computer-use')?.builtin).toBe(true);
    expect(library.find((skill) => skill.name === 'phone-harness')?.builtin).toBe(true);
    expect(library.find((skill) => skill.name === 'web-research')?.builtin).toBeFalsy();
  });
});

describe('plugins', () => {
  it('reads the repo shapes people actually paste', () => {
    expect(plugins.parseRepoRef('owner/repo')).toMatchObject({ owner: 'owner', repo: 'repo', subPath: '' });
    expect(plugins.parseRepoRef('https://github.com/owner/repo/tree/dev/packs/a')).toMatchObject({
      owner: 'owner',
      repo: 'repo',
      ref: 'dev',
      subPath: 'packs/a',
    });
    expect(plugins.parseRepoRef('https://example.com/SKILL.md')).toBeNull();
  });

  it('installs a reviewed plan and mounts its mcp servers switched off', () => {
    const body = '# Pack skill\n\nDoes a thing.';
    const { plugin, notes } = plugins.installPlugin(skills.GLOBAL_SCOPE, {
      name: 'pack',
      description: '',
      source: 'owner/pack',
      skills: [{ name: 'pack-skill', summary: 'Does a thing.', path: 'skills/pack-skill/SKILL.md', body, sha256: skills.sha256(body) }],
      mcpServers: [{ name: 'pack/db', enabled: true, transport: 'stdio', command: 'db-mcp' }],
      warnings: [],
    });

    expect(plugin.skills).toEqual(['pack-skill']);
    expect(skills.listSkills(skills.GLOBAL_SCOPE).some((s) => s.name === 'pack-skill')).toBe(true);
    // A package does not get to decide what runs on this machine.
    expect(getConfig().mcpServers.find((s) => s.name === 'pack/db')!.enabled).toBe(false);
    expect(notes.join(' ')).toContain('switched off');

    plugins.removePlugin(plugin.id);
    expect(skills.listSkills(skills.GLOBAL_SCOPE).some((s) => s.name === 'pack-skill')).toBe(false);
    expect(getConfig().mcpServers.some((s) => s.name === 'pack/db')).toBe(false);
  });

  it('refuses a skill whose bytes differ from the reviewed digest', () => {
    saveConfig({ mcpServers: [] });
    const { plugin, notes } = plugins.installPlugin(skills.GLOBAL_SCOPE, {
      name: 'tampered',
      description: '',
      source: 'owner/tampered',
      skills: [{ name: 'tampered-skill', summary: '', path: 'SKILL.md', body: '# Real body', sha256: 'not-the-digest' }],
      mcpServers: [],
      warnings: [],
    });

    expect(plugin.skills).toEqual([]);
    expect(notes.join(' ')).toContain('differ from the reviewed plan');
  });
});

describe('frontmatter block scalars', () => {
  it('reads a folded description instead of stopping at the marker', () => {
    // Real skills in the wild write `description: >` and continue underneath. Taking
    // the marker literally summarised a whole library as ">".
    const meta = skills.summarize('---\nname: academy-guide\ndescription: >\n  Guides a reader through the academy,\n  one lesson at a time.\nlicense: MIT\n---\n\n# Academy');
    expect(meta.name).toBe('academy-guide');
    expect(meta.summary).toBe('Guides a reader through the academy, one lesson at a time.');
  });

  it('still reads a plain one-line description', () => {
    expect(skills.summarize('---\ndescription: "One line."\n---\n').summary).toBe('One line.');
  });
});
