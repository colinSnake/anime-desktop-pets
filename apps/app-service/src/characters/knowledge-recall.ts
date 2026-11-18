import { credentialLike, knowledgeCollision, normalizeMemoryText, type Memory } from '../../../../packages/contracts/src/character-records.ts';
import { isKnowledgeQuery, knowledgeMatchLimit, usableKnowledge } from '../../../../packages/contracts/src/knowledge-search.ts';

const stopwords = new Set(['什么', '怎么', '为什么', '是不是', '可以', '能不能', '一下', '请问', '告诉', '觉得', '记得', '关于', '这个', '那个', '之前', '说过']);
const han = /^\p{Script=Han}/u;
function terms(text: string) {
  const tokens = new Set<string>();
  const normalized = text.normalize('NFKC').toLowerCase().replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  for (const match of normalized.matchAll(/\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}])+/gu)) {
    const word = match[0], letters = Array.from(word);
    if (han.test(word)) {
      for (let i = 1; i < letters.length; i++) {
        const pair = letters[i - 1]! + letters[i]!;
        if (!stopwords.has(pair)) tokens.add(pair);
      }
    } else if (letters.length > 1) tokens.add(word);
  }
  return tokens;
}

type Eligible = (memory: Memory) => boolean;

export function recallKnowledge(query: string, current: readonly Memory[], now: string): string[] {
  return recallKnowledgeRecords(query, current, now).map(record => record.id);
}

export function recallKnowledgeRecords(query: string, current: readonly Memory[], now: string, eligible?: Eligible): Memory[] {
  return recallMatches(query, current.filter(memory => usableKnowledge(memory, now)), true, eligible);
}

export function recallPersonal(query: string, current: readonly Memory[], eligible?: Eligible): Memory[] {
  return recallMatches(query, current.filter(memory => memory.kind !== '知识' && memory.status === 'confirmed' && !credentialLike(memory)), false, eligible);
}

function scorer(query: string) {
  const phrase = normalizeMemoryText(query), keywords = terms(query);
  return (fields: readonly string[]) => {
    if (fields.some(field => normalizeMemoryText(field).includes(phrase))) return 2;
    if (!keywords.size) return 0;
    const available = terms(fields.join(' '));
    const count = [...keywords].filter(term => available.has(term)).length;
    return count * 4 >= keywords.size ? count / keywords.size : 0;
  };
}

export function queryScorer(query: string) {
  return isKnowledgeQuery(query) ? scorer(query) : undefined;
}

function recallMatches(query: string, candidates: readonly Memory[], evidence: boolean, eligible?: Eligible): Memory[] {
  const scoreOf = queryScorer(query);
  if (!scoreOf) return [];
  const referenceTexts = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const memory of candidates) {
    const reference = knowledgeCollision(memory);
    if (reference === undefined) continue;
    const text = normalizeMemoryText(memory.text), previous = referenceTexts.get(reference);
    if (previous === undefined) referenceTexts.set(reference, text);
    else if (previous !== text) conflicts.add(reference);
  }
  const ranked: Array<{ memory: Memory; score: number }> = [];
  for (const memory of candidates) {
    const reference = knowledgeCollision(memory);
    if ((reference !== undefined && conflicts.has(reference)) || (eligible && !eligible(memory))) continue;
    const score = scoreOf(evidence ? [memory.text, memory.source, memory.citation, memory.version] : [memory.text]);
    if (score > 0) ranked.push({ memory, score });
  }
  return ranked.sort((a, b) => b.score - a.score || b.memory.createdAt.localeCompare(a.memory.createdAt) || a.memory.id.localeCompare(b.memory.id))
    .slice(0, knowledgeMatchLimit).map(({ memory }) => memory);
}
