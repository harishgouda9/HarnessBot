import type { ActivityBeat } from './types.ts';

/**
 * Commands and files for the open task, read back from activity chips.
 *
 * A file tool contributes a path only. The rest of its line can be file contents,
 * and those never belong on this strip. Size is filled in by the harness, which
 * can stat a path without reading it.
 */

const FILE_TOOLS = new Set(['read', 'write', 'edit', 'notebookedit', 'delete']);
const SKIP_TOOLS = new Set(['setup', 'error', 'timeout', 'queue', 'engine', 'computer']);

export interface ActivityMessage {
  at: number;
  kind: string;
  text?: string;
  tool?: { name: string; ok?: boolean };
}

export function activityBeats(messages: ActivityMessage[]): ActivityBeat[] {
  const beats: ActivityBeat[] = [];
  for (const message of messages) {
    if (message.kind !== 'activity' || !message.tool?.name) continue;
    const tool = message.tool.name;
    if (SKIP_TOOLS.has(tool.toLowerCase())) continue;
    const line = (message.text ?? '').split(/\r?\n/, 1)[0]?.trim().slice(0, 180) ?? '';
    const beat: ActivityBeat = { at: message.at, tool };
    if (message.tool.ok === true) beat.exitCode = 0;
    else if (message.tool.ok === false) beat.exitCode = 1;
    if (FILE_TOOLS.has(tool.toLowerCase())) {
      const found = asPath(line);
      if (found) beat.path = found;
    } else if (line) {
      beat.command = line;
    }
    beats.push(beat);
  }
  return beats.slice(-40);
}

/** A single path token. Anything with a space after it is left out. */
function asPath(line: string): string | undefined {
  const token = line.split(/\s+/)[0] ?? '';
  if (token.length < 2 || token.length > 300) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(token) || token.startsWith('/') || token.startsWith('~/')) return token;
  if ((token.includes('/') || token.includes('\\')) && !token.includes('=')) return token;
  return undefined;
}
