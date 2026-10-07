import fs from 'node:fs';
import path from 'node:path';
import { activityBeats } from '../shared/activity.ts';
import type { ActivityBeat } from '../shared/types.ts';
import { redactSecretsInText } from './redact.ts';
import { store } from './store.ts';

/**
 * Activity beside the computer screen for one task.
 *
 * Derived from chips already in the transcript. File size comes from stat.
 * The file itself is never read, and this list is not a second decision log.
 */
export function threadActivity(threadId: string): ActivityBeat[] {
  return activityBeats(store.listMessages(threadId)).map((beat) => {
    const next: ActivityBeat = { ...beat };
    if (next.command) next.command = redactSecretsInText(next.command);
    if (!next.path || !path.isAbsolute(next.path)) return next;
    try {
      const stat = fs.statSync(next.path);
      if (stat.isFile()) next.bytes = stat.size;
    } catch {
      // The tool named a path that is already gone. Show the path without a size.
    }
    return next;
  });
}
