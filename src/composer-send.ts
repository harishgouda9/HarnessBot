export interface ComposerDraft<TFile = { id: string; name: string; mime: string; url: string }> {
  text: string;
  files: TFile[];
  context: string;
}

/** Clear the composer after a send is accepted. A failure puts the same draft back. */
export function draftAfterSend<TFile>(
  draft: ComposerDraft<TFile>,
  error: unknown,
): { draft: ComposerDraft<TFile>; error: string | null } {
  if (error == null) return { draft: { text: '', files: [], context: '' }, error: null };
  const message = error instanceof Error && error.message ? error.message : 'The message was not sent.';
  return { draft, error: message };
}

/** A keystroke or file added after Send wins over a late failure restoring the old draft. */
export function draftAfterFailure<TFile>(
  failed: ComposerDraft<TFile>,
  current: ComposerDraft<TFile>,
  touchedAfterClear: boolean,
): ComposerDraft<TFile> {
  return touchedAfterClear ? current : failed;
}
