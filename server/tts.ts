import { getSecret } from './config.ts';

/**
 * Text to speech runs on the harness, never in the renderer, so the ElevenLabs key
 * never reaches a page that also renders untrusted model output (HB-TRD-001 s2.1).
 */

const API = 'https://api.elevenlabs.io/v1';

/**
 * Markdown reads terribly aloud: bullets become "dash", code blocks become noise,
 * links become URLs. Rewrite to something a person would actually say.
 */
export function speechFriendly(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' (code block) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' (image) ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_~>]/g, '')
    .replace(/\s*\n\s*\n\s*/g, '. ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}

export interface Voice {
  id: string;
  name: string;
  preview?: string;
}

export async function listVoices(): Promise<Voice[]> {
  const key = getSecret('elevenlabs.key');
  if (!key) return [];
  const res = await fetch(`${API}/voices`, { headers: { 'xi-api-key': key } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);
  const json = (await res.json()) as { voices?: { voice_id: string; name: string; preview_url?: string }[] };
  return (json.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, preview: v.preview_url }));
}

export interface SpeakResult {
  audio: Buffer;
  mime: string;
}

export async function speak(text: string, voiceId: string): Promise<SpeakResult> {
  const key = getSecret('elevenlabs.key');
  if (!key) throw new Error('No ElevenLabs key configured');
  if (!voiceId) throw new Error('No voice selected');
  const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
    body: JSON.stringify({ text: speechFriendly(text), model_id: 'eleven_turbo_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
}

export function ttsConfigured(): boolean {
  return Boolean(getSecret('elevenlabs.key'));
}
