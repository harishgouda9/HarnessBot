/**
 * Dictation only edits the composer. `send` is always false: a transcript is
 * not a message until the user presses Send.
 */
export function applyDictation(current: string, transcript: string | null | undefined): { text: string; send: false } {
  const spoken = (transcript ?? '').replace(/\s+/g, ' ').trim();
  if (!spoken) return { text: current, send: false };
  const base = current.replace(/\s+$/, '');
  return { text: base ? `${base} ${spoken}` : spoken, send: false };
}

export function speechAvailability(platform: string, hasRecognizer: boolean): { available: boolean; reason?: string } {
  if (hasRecognizer) return { available: true };
  if (platform === 'win32') {
    return { available: false, reason: 'Windows speech recognition is not available in this session.' };
  }
  if (platform === 'darwin') {
    return { available: false, reason: 'Apple speech recognition is not available in this session.' };
  }
  return { available: false, reason: 'Dictation is not available on this platform.' };
}

export function detectSpeechPlatform(): string {
  if (typeof navigator === 'undefined') return 'other';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('win')) return 'win32';
  if (platform.includes('mac')) return 'darwin';
  return 'other';
}
