import { graphemes, invalidLegacy, legacyBool, legacyMarkdown, legacyVersion, onlyLegacyFields } from './legacy-document.ts';

const identitySections = {
  role: '身份定位', background: '背景', personality: '性格', values: '核心价值观', motivations: '当前愿望与长期方向',
  relationship: '与用户的关系', speakingStyle: '表达方式', knowledgeScope: '知识与擅长边界', boundaries: '边界',
} as const;
const kinds = ['事实', '偏好', '经历', '知识'] as const;
const goalStatuses = ['进行中', '已暂停', '已完成'] as const;
function choice<const T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) return invalidLegacy();
  return value as T;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Fa-f0-9-]{16,64}$/.test(value);
function revision(value: unknown): number { return legacyVersion(value ?? 1, Number.MAX_SAFE_INTEGER); }
function timestamp(value: unknown): string {
  // Foundation's JSONEncoder .iso8601 writes whole UTC seconds. Roundtrip to
  // reject rollover such as February 30 instead of silently changing history.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().replace('.000Z', 'Z') !== value) return invalidLegacy();
  return value;
}
function text(value: unknown, limit: number, options: { required?: boolean; multiline?: boolean } = {}): string {
  if (typeof value !== 'string' || (options.required && !value.trim()) ||
      /[\p{Cs}\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value) ||
      (!options.multiline && /[\n\u2028\u2029]/u.test(value)) || graphemes(value) > limit) return invalidLegacy();
  return value;
}
function sections(lines: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let title: string | undefined, paragraph: string[] = [];
  const flush = () => { if (title !== undefined) result.set(title, paragraph.join('\n').trim()); };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush(); title = line.slice(3); paragraph = [];
      if (result.has(title)) return invalidLegacy();
    } else if (title !== undefined) {
      paragraph.push(line);
    }
  }
  flush();
  return result;
}

/** An imported sharing bit is historical metadata, never a grant to call a provider. */
export function decodeLegacyIdentity(bytes: Uint8Array, fallbackTime: string) {
  const { meta, lines } = legacyMarkdown(bytes);
  onlyLegacyFields(meta, ['schema', 'shareWithOnlineModel', 'createdAt', 'updatedAt', 'revision']);
  const sourceSchema = legacyVersion(meta.schema, 2), heading = lines.find(Boolean);
  if (!heading?.startsWith('# ')) return invalidLegacy();
  const name = text(heading.slice(2).trim(), 80, { required: true });
  const content = sections(lines);
  const parts = (Object.keys(identitySections) as Array<keyof typeof identitySections>).map(key =>
    [key, text(content.get(identitySections[key]) ?? '', 2000, { multiline: true })] as const);
  if (parts.reduce((n, [, value]) => n + graphemes(value), graphemes(name)) > 8000) return invalidLegacy();
  const createdAt = timestamp(meta.createdAt ?? fallbackTime);
  return { sourceSchema, name, ...Object.fromEntries(parts) as Record<keyof typeof identitySections, string>,
    createdAt, updatedAt: timestamp(meta.updatedAt ?? createdAt), revision: revision(meta.revision), recordedShareWithOnlineModel: legacyBool(meta.shareWithOnlineModel) };
}

export function decodeLegacyMemory(bytes: Uint8Array, expectedID: string) {
  const { meta, lines } = legacyMarkdown(bytes);
  onlyLegacyFields(meta, ['schema','id','kind','createdAt','updatedAt','confirmedAt','revision','source','citation','version','expiresAt','status','shareWithOnlineModel']);
  if (meta.id !== expectedID || !identifier(meta.id)) return invalidLegacy();
  const sourceSchema = legacyVersion(meta.schema, 4), createdAt = timestamp(meta.createdAt), kind = choice(meta.kind, kinds);
  const status = choice(meta.status, ['candidate', 'confirmed']);
  const confirmedAt = meta.confirmedAt != null ? timestamp(meta.confirmedAt) : status === 'confirmed' ? createdAt : undefined;
  const expiresAt = meta.expiresAt == null ? undefined : timestamp(meta.expiresAt);
  if (kind !== '知识' && expiresAt !== undefined) return invalidLegacy();
  return { sourceSchema, id: meta.id, kind, text: text(lines.join('\n').replace(/^\n+|\n+$/g, ''), 1000, { required: true, multiline: true }),
    createdAt, updatedAt: timestamp(meta.updatedAt ?? createdAt), revision: revision(meta.revision),
    ...(confirmedAt === undefined ? {} : { confirmedAt }), ...(expiresAt === undefined ? {} : { expiresAt }),
    source: text(meta.source, 200), citation: text(meta.citation ?? '', 500), version: text(meta.version ?? '', 80),
    status, recordedShareWithOnlineModel: legacyBool(meta.shareWithOnlineModel) };
}

export function decodeLegacyGoal(bytes: Uint8Array, expectedID: string) {
  const { meta, lines } = legacyMarkdown(bytes);
  onlyLegacyFields(meta, ['schema','id','createdAt','status','shareWithOnlineModel']);
  const sourceSchema = legacyVersion(meta.schema, 2), heading = lines.find(line => line.startsWith('# '));
  if (meta.id !== expectedID || !identifier(meta.id) || !heading) return invalidLegacy();
  const content = sections(lines), stepLines = (content.get('步骤') ?? '').split('\n').filter(line => line.trim());
  if (stepLines.length > 50) return invalidLegacy();
  const ids = new Set<string>();
  const steps = stepLines.map(line => {
    const match = /^- \[([ x])\] (?:\d+\. )?(.+?) <!-- ([A-Fa-f0-9-]{16,64}) -->$/.exec(line);
    if (!match || ids.has(match[3]!) || /<!--|-->/.test(match[2]!)) return invalidLegacy();
    const id = match[3]!; ids.add(id);
    return { id, text: text(match[2]!.trim(), 500, { required: true }), isComplete: match[1] === 'x' };
  });
  return { sourceSchema, id: meta.id, title: text(heading.slice(2).trim(), 120, { required: true }),
    details: text(content.get('说明') ?? '', 2000, { multiline: true }), steps, createdAt: timestamp(meta.createdAt), status: choice(meta.status, goalStatuses),
    recordedShareWithOnlineModel: legacyBool(meta.shareWithOnlineModel ?? false) };
}
