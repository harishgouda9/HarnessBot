import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../shared/types.ts';
import { dataPath } from './paths.ts';

/**
 * Attachments live under a generated id, never the client-supplied name.
 * The transcript stores a URL the UI can fetch; the turn needs a path the bot
 * can actually open, and (for images) the bytes the driver declared it can see.
 */

export const ATTACHMENTS_DIR = (): string => dataPath('attachments');

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i;

export function attachmentPath(url: string): string | null {
  const name = path.basename(url);
  if (!name || name === '.' || name === '..') return null;
  const dir = ATTACHMENTS_DIR();
  const file = path.join(dir, name);
  if (!path.resolve(file).startsWith(path.resolve(dir))) return null;
  return fs.existsSync(file) ? file : null;
}

/** Vision payloads for drivers that declared `images`. Missing files are skipped. */
export function imagesFromAttachments(
  attachments: Message['attachments'] | undefined,
): { mime: string; data: string }[] {
  if (!attachments?.length) return [];
  const out: { mime: string; data: string }[] = [];
  for (const item of attachments) {
    if (!IMAGE_MIME.test(item.mime)) continue;
    const file = attachmentPath(item.url);
    if (!file) continue;
    out.push({ mime: item.mime, data: fs.readFileSync(file).toString('base64') });
  }
  return out;
}

/**
 * A note the model can act on: names plus absolute paths, so a bot with a shell
 * can open a PDF it cannot otherwise see.
 */
export function describeAttachments(attachments: Message['attachments'] | undefined): string {
  if (!attachments?.length) return '';
  const lines = attachments.map((item) => {
    const file = attachmentPath(item.url);
    return file ? `- ${item.name} (${item.mime}) at ${file}` : `- ${item.name} (${item.mime})`;
  });
  return `Attached files:\n${lines.join('\n')}`;
}

export function composeTurnText(text: string, attachments: Message['attachments'] | undefined, context?: string): string {
  const parts: string[] = [];
  if (context?.trim()) parts.push(`Context:\n${context.trim()}`);
  if (text.trim()) parts.push(text.trim());
  const note = describeAttachments(attachments);
  if (note) parts.push(note);
  return parts.join('\n\n');
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

export function mimeForFilename(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}
