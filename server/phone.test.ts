import { describe, expect, it } from 'vitest';
import { authorizePhoneAction, readPhoneList } from './phone.ts';

describe('phone gate', () => {
  it('refuses send, pay, and delete until an approval, then allows them', () => {
    for (const action of ['send', 'pay', 'delete'] as const) {
      const denied = authorizePhoneAction(action, false);
      expect(denied.allowed).toBe(false);
      expect(denied.reason).toBe('Send, pay, and delete need an explicit approval before they run on the phone.');
      expect(denied.reason?.startsWith(action)).toBe(false);
      expect(authorizePhoneAction(action, true).allowed).toBe(true);
    }
  });

  it('reports a missing phone as unavailable and does not invent a device', () => {
    const missing = readPhoneList({ ok: false, stderr: 'adb is not recognized' });
    expect(missing.available).toBe(false);
    expect(missing.devices).toEqual([]);
    expect(missing.reason).toMatch(/adb/);

    const listed = readPhoneList({ ok: true, stdout: 'List of devices attached\nABC123\tdevice\n' });
    expect(listed.available).toBe(true);
    expect(listed.devices.map((device) => device.serial)).toEqual(['ABC123']);
    expect(listed.devices[0]!.screenshot).toBeNull();
  });
});
