import { describe, expect, it } from 'vitest';
import { normalizeBase } from './api.ts';

/**
 * The UI is served two ways: standalone (same origin as the harness) and mounted
 * inside the Hermes dashboard, where the API sits behind a prefix. Getting the join
 * wrong in the second case sends every call to the wrong place, so the seam is pinned.
 *
 * Values arrive slash-free from the environment because MSYS shells rewrite a
 * leading-slash value into a Windows path; both forms have to land on the same base.
 */
describe('normalizeBase', () => {
  it('stays empty for the standalone build', () => {
    expect(normalizeBase('')).toBe('');
  });

  it('accepts the slash-free form the build script passes', () => {
    expect(normalizeBase('api/plugins/harnessbot/hb')).toBe('/api/plugins/harnessbot/hb');
  });

  it('accepts a leading and trailing slash without doubling either', () => {
    expect(normalizeBase('/api/plugins/harnessbot/hb/')).toBe('/api/plugins/harnessbot/hb');
    expect(normalizeBase('/api/plugins/harnessbot/hb')).toBe('/api/plugins/harnessbot/hb');
  });

  it('composes with a harness path into exactly one slash', () => {
    expect(`${normalizeBase('api/plugins/harnessbot/hb')}/api/events`).toBe(
      '/api/plugins/harnessbot/hb/api/events',
    );
    expect(`${normalizeBase('')}/api/events`).toBe('/api/events');
  });
});
