import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { credentialLike, isKnowledgeParagraphs, KNOWLEDGE_IMPORT_BYTES, KNOWLEDGE_IMPORT_LIMIT } from '../../../packages/contracts/src/character-records.ts';
import type { KnowledgeFileResult } from '../../../packages/contracts/src/knowledge-import.ts';

const invalidFile = { ok: false, error: 'invalid-file' } as const;
const unavailable = { ok: false, error: 'unavailable' } as const;
export async function readKnowledgeFile(path: string): Promise<KnowledgeFileResult> {
  if (!isAbsolute(path) || path.length > 4096 || !['.txt', '.md'].includes(extname(path).toLowerCase())) return invalidFile;
  let bytes: Buffer;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) return invalidFile;
      if (before.size > KNOWLEDGE_IMPORT_BYTES) return { ok: false, error: 'limit' };
      const buffer = Buffer.alloc(KNOWLEDGE_IMPORT_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > KNOWLEDGE_IMPORT_BYTES) return { ok: false, error: 'limit' };
      const after = await file.stat({ bigint: true });
      if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return invalidFile;
      bytes = buffer.subarray(0, size);
    } finally { await file.close(); }
  } catch { return invalidFile; }

  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/g, '\n'); }
  catch { return { ok: false, error: 'invalid-text' }; }
  if (credentialLike({ kind: '知识', text, source: '', citation: '', version: '' })) return { ok: false, error: 'credential-like' };
  const chunks: string[] = [];
  let lines: string[] = [];
  for (const line of [...text.split('\n'), '']) {
    if (line.trim()) lines.push(line);
    else if (lines.length) {
      chunks.push(lines.join('\n').trim());
      lines = [];
      if (chunks.length > KNOWLEDGE_IMPORT_LIMIT) return { ok: false, error: 'limit' };
    }
  }
  const paragraphs = [...new Set(chunks)];
  if (!isKnowledgeParagraphs(paragraphs) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) return { ok: false, error: 'invalid-text' };
  return { ok: true, paragraphs };
}

export class KnowledgeFilePicker {
  private busy = false;
  async select(choose: () => Promise<{ canceled: boolean; filePaths: string[] }>, stillCurrent: () => boolean): Promise<KnowledgeFileResult> {
    if (this.busy) return { ok: false, error: 'busy' };
    this.busy = true;
    try {
      if (!stillCurrent()) return unavailable;
      const { canceled, filePaths } = await choose();
      if (!stillCurrent()) return unavailable;
      if (canceled) return { ok: false, error: 'cancelled' };
      if (filePaths.length !== 1 || !filePaths[0]) return invalidFile;
      const result = await readKnowledgeFile(filePaths[0]);
      return stillCurrent() ? result : unavailable;
    } catch { return unavailable; }
    finally { this.busy = false; }
  }
}
