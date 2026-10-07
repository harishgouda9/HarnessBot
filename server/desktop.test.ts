import { describe, expect, it } from 'vitest';
import { explicitSecretValue, loginItemSettings, packageStatus } from './desktop.ts';

describe('packageStatus', () => {
  it('reports unsigned and no update source when no certificate or feed is configured', () => {
    const status = packageStatus({} as NodeJS.ProcessEnv, 'win32');
    expect(status.signed).toBe(false);
    expect(status.installer).toBe('unsigned');
    expect(status.updateSource).toBeNull();
    expect(status.updateCheck).toBe('no-source');
  });

  it('reports a signature and a feed only when those are configured', () => {
    const status = packageStatus({ CSC_LINK: 'cert.pfx', HB_UPDATE_FEED: 'https://updates.example.test/feed' } as NodeJS.ProcessEnv, 'win32');
    expect(status.signed).toBe(true);
    expect(status.installer).toBe('signed');
    expect(status.updateSource).toBe('https://updates.example.test/feed');
    expect(status.updateCheck).toBe('configured');
  });
});

describe('explicit secrets and login', () => {
  it('rejects an empty secret and keeps a submitted one', () => {
    expect(explicitSecretValue('   ')).toBeNull();
    expect(explicitSecretValue(null)).toBeNull();
    expect(explicitSecretValue('sk-real')).toBe('sk-real');
  });

  it('maps start-at-login to the OS login item', () => {
    expect(loginItemSettings(true)).toEqual({ openAtLogin: true, openAsHidden: true });
    expect(loginItemSettings(false)).toEqual({ openAtLogin: false, openAsHidden: false });
  });
});
