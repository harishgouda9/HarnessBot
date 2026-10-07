import { execFile } from 'node:child_process';

export type PhoneSensitiveAction = 'send' | 'pay' | 'delete';

export interface PhoneDevice {
  serial: string;
  state: string;
  screenshot: { mime: string; png: string; at: number } | null;
}

export interface PhoneList {
  available: boolean;
  reason?: string;
  devices: PhoneDevice[];
}

const shots = new Map<string, { mime: string; png: string; at: number }>();

/**
 * Send, pay, and delete do not proceed without an explicit approval.
 * Other phone actions are not this gate.
 */
export function authorizePhoneAction(action: string, approved: boolean): { action: string; allowed: boolean; reason?: string } {
  const sensitive = action === 'send' || action === 'pay' || action === 'delete';
  if (!sensitive) return { action, allowed: true };
  if (approved !== true) {
    return {
      action,
      allowed: false,
      reason: 'Send, pay, and delete need an explicit approval before they run on the phone.',
    };
  }
  return { action, allowed: true };
}

/** Parse `adb devices`. A failed adb is an empty list with a reason, never a made-up phone. */
export function readPhoneList(adb: { ok: boolean; stdout?: string; stderr?: string }): PhoneList {
  if (!adb.ok) {
    return {
      available: false,
      reason: 'adb is not available. Install platform-tools and accept USB debugging on the phone.',
      devices: [],
    };
  }
  const devices: PhoneDevice[] = [];
  for (const line of (adb.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
    const [serial, state] = trimmed.split(/\s+/);
    if (!serial || !state || state === 'offline') continue;
    devices.push({ serial, state, screenshot: shots.get(serial) ?? null });
  }
  return { available: true, devices };
}

function runAdb(args: string[], timeout = 4000): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile('adb', args, { timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
      const errText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
      if (err) resolve({ ok: false, stdout: out, stderr: errText || err.message });
      else resolve({ ok: true, stdout: out, stderr: errText });
    });
  });
}

export async function queryPhones(): Promise<PhoneList> {
  const result = await runAdb(['devices']);
  return readPhoneList({ ok: result.ok, stdout: result.stdout.toString('utf8'), stderr: result.stderr });
}

export async function capturePhone(serial: string): Promise<{ available: boolean; reason?: string; screenshot?: PhoneDevice['screenshot'] }> {
  const list = await queryPhones();
  if (!list.available) return { available: false, reason: list.reason };
  const device = list.devices.find((item) => item.serial === serial && item.state === 'device');
  if (!device) return { available: false, reason: 'That phone is not connected.' };
  const shot = await runAdb(['-s', serial, 'exec-out', 'screencap', '-p'], 8000);
  if (!shot.ok || shot.stdout.length === 0) return { available: false, reason: 'Could not capture a screenshot from this phone.' };
  const screenshot = { mime: 'image/png', png: shot.stdout.toString('base64'), at: Date.now() };
  shots.set(serial, screenshot);
  return { available: true, screenshot };
}
