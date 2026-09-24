import { describe, expect, it } from 'vitest';
import { isValidSkillName, MAX_SKILL_NAME, slugifySkillName } from '../shared/skill-name.ts';

describe('skill names', () => {
  it('accepts kebab-case and rejects what the server would reject', () => {
    expect(isValidSkillName('deploy-staging')).toBe(true);
    expect(isValidSkillName('Deploy Staging')).toBe(false);
    expect(isValidSkillName('deploy--staging')).toBe(false);
    expect(isValidSkillName('-deploy')).toBe(false);
    expect(isValidSkillName('a'.repeat(MAX_SKILL_NAME + 1))).toBe(false);
  });

  it('slugifies anything typed into something valid', () => {
    for (const input of ['Deploy Staging', '  Deploy   Staging!! ', 'deploy_staging', 'Deploy—Staging', 'x'.repeat(80)]) {
      const slug = slugifySkillName(input);
      expect(isValidSkillName(slug), `${input} -> ${slug}`).toBe(true);
    }
  });

  it('has nothing to offer for input with no usable characters', () => {
    expect(slugifySkillName('!!!')).toBe('');
    expect(isValidSkillName('')).toBe(false);
  });
});
