import { credentialLike, isKnowledgeParagraphs, knowledgeCollision, normalizeMemoryText, MEMORY_LIMIT, type KnowledgeDraft, type MemoryDraft } from './character-records.ts';
import { shape } from './pets.ts';

const pickerErrors = ['busy', 'cancelled', 'invalid-file', 'invalid-text', 'limit', 'credential-like', 'unavailable'] as const;
export type KnowledgeFileResult = { ok: true; paragraphs: string[] } | { ok: false; error: typeof pickerErrors[number] };
export interface KnowledgeFileBridge { selectKnowledgeFile(): Promise<KnowledgeFileResult>; }

export function isKnowledgeFileResult(value: unknown): value is KnowledgeFileResult {
  if (shape(value, ['ok', 'paragraphs']) && value.ok === true && isKnowledgeParagraphs(value.paragraphs)) {
    return !credentialLike({ kind: '知识', text: value.paragraphs.join('\n\n'), source: '', citation: '', version: '' });
  }
  return shape(value, ['ok', 'error']) && value.ok === false && pickerErrors.some(error => error === value.error);
}

/** Both the preview and the repository apply this check against their current snapshot. */
export function knowledgeBatchIssue(drafts: KnowledgeDraft[], saved: readonly MemoryDraft[], now: string) {
  if (saved.length + drafts.length > MEMORY_LIMIT) return 'limit';
  const active = saved.filter(item => item.kind === '知识' && (!item.expiresAt || item.expiresAt > now));
  const texts = new Set(active.map(item => normalizeMemoryText(item.text)));
  const references = new Set(active.map(knowledgeCollision).filter(key => key !== undefined));
  for (const draft of drafts) {
    if (credentialLike(draft)) return 'credential-like';
    if (draft.expiresAt && draft.expiresAt <= now) return 'expired';
    const text = normalizeMemoryText(draft.text), reference = knowledgeCollision(draft);
    if (texts.has(text)) return 'duplicate';
    if (reference !== undefined && references.has(reference)) return 'knowledge-conflict';
    texts.add(text);
    if (reference !== undefined) references.add(reference);
  }
}
