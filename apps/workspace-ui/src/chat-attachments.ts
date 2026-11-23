import { bytesToBase64, chatFileType, chatAttachmentLimits, validateChatAttachments, type ChatAttachment } from '../../../packages/contracts/src/chat-attachments.ts';

export type ChatFileReadResult = { ok: true; attachments: ChatAttachment[] } | { ok: false; error: 'limit' | 'unsupported' | 'invalid' };
/** Read only files explicitly selected in the current renderer turn; never request or expose a filesystem path. */
export async function readChatFiles(files: readonly Pick<File, 'name' | 'type' | 'size' | 'arrayBuffer'>[], question: string): Promise<ChatFileReadResult> {
  if (files.length > chatAttachmentLimits.maxFiles) return { ok: false, error: 'limit' };
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > chatAttachmentLimits.maxFileBytes) return { ok: false, error: 'limit' };
    total += file.size;
    if (total > chatAttachmentLimits.maxTotalBytes) return { ok: false, error: 'limit' };
  }
  const types = files.map(file => chatFileType(file.name));
  if (types.some((type, i) => !type || (type !== 'text/plain' && !!files[i]!.type && files[i]!.type !== type))) return { ok: false, error: 'unsupported' };
  const items: ChatAttachment[] = [];
  try {
    for (const [i, file] of files.entries()) {
      const mediaType = types[i]!;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size) return { ok: false, error: 'invalid' };
      items.push({ name: file.name, mediaType, data: bytesToBase64(bytes) });
    }
  } catch {
    return { ok: false, error: 'invalid' };
  }
  const validated = validateChatAttachments(items, question);
  if (!validated.ok) return { ok: false, error: 'invalid' };
  return { ok: true, attachments: validated.attachments.map(({ name, mediaType, data }) => ({ name, mediaType, data })) };
}

export async function readAgentTaskFiles(selected: Parameters<typeof readChatFiles>[0], prompt: string, existing: readonly ChatAttachment[]): Promise<
  ChatFileReadResult | { ok: false; error: 'duplicate' }
> {
  if (existing.length + selected.length > chatAttachmentLimits.maxFiles) return { ok: false, error: 'limit' };
  if (selected.some(file => chatFileType(file.name) !== 'text/plain')) return { ok: false, error: 'unsupported' };
  const names = new Set(existing.map(file => file.name.toLocaleLowerCase('en-US')));
  for (const file of selected) {
    const key = file.name.toLocaleLowerCase('en-US');
    if (names.has(key)) return { ok: false, error: 'duplicate' };
    names.add(key);
  }
  const read = await readChatFiles(selected, prompt);
  if (!read.ok) return read;
  const attachments = [...existing, ...read.attachments];
  return validateChatAttachments(attachments, prompt).ok ? { ok: true, attachments } : { ok: false, error: 'limit' };
}
