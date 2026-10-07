import { describe, expect, it } from 'vitest';
import { staticMiss } from './static-miss.ts';

describe('staticMiss', () => {
  it('falls back to the shell only for html and extensionless routes', () => {
    expect(staticMiss('/')).toBe('spa');
    expect(staticMiss('/chat')).toBe('spa');
    expect(staticMiss('/index.html')).toBe('spa');
    expect(staticMiss('/assets/index-abc.js')).toBe('missing');
    expect(staticMiss('/favicon.ico')).toBe('missing');
  });
});
