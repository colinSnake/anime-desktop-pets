export type ChatDraft = Readonly<{ text: string; selection: Readonly<{ anchor: number; focus: number }> }>;

// Editing limit, intentionally above the send limit, so ordinary over-limit drafts remain editable.
export const chatDraftLimit = 16_384;
export function textDraft(text: string): ChatDraft {
  return Object.freeze({ text, selection: Object.freeze({ anchor: text.length, focus: text.length }) });
}
export function acceptedDraft({ text, selection }: ChatDraft): boolean {
  return text.length <= chatDraftLimit && [selection.anchor, selection.focus].every(offset => Number.isInteger(offset) && offset >= 0 && offset <= text.length);
}
export function sameDraft(a: ChatDraft, b: ChatDraft): boolean {
  return a.text === b.text && a.selection.anchor === b.selection.anchor && a.selection.focus === b.selection.focus;
}
