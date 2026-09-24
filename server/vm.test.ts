import { describe, expect, it } from 'vitest';
import { viewerFrom } from './vm.ts';

/**
 * The desktop viewer is only ever offered on loopback. A container that ended up
 * published on 0.0.0.0 is reachable from the network, and linking to it would quietly
 * turn a local sandbox into a shared one.
 */
describe('local vm viewer', () => {
  it('reads the loopback noVNC port out of a ports column', () => {
    expect(viewerFrom('127.0.0.1:49154->6080/tcp, 5900/tcp')).toContain('http://127.0.0.1:49154/vnc.html');
  });

  it('offers nothing when noVNC is not published on loopback', () => {
    expect(viewerFrom('0.0.0.0:6080->6080/tcp')).toBeUndefined();
    expect(viewerFrom('127.0.0.1:49154->5900/tcp')).toBeUndefined();
    expect(viewerFrom('')).toBeUndefined();
  });
});
