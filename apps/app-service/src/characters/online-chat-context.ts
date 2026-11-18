import { parseLocalChatCommand } from '../../../../packages/contracts/src/local-chat.ts';
import { knowledgeMatchLimit, knowledgeQueryLimit } from '../../../../packages/contracts/src/knowledge-search.ts';
import type { Memory } from '../../../../packages/contracts/src/character-records.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { chatGoal, chatIdentity, safeChatFields } from './chat-context-policy.ts';
import { queryScorer, recallKnowledgeRecords, recallPersonal } from './knowledge-recall.ts';
import type { CharacterState } from './records.ts';
import type { CharacterRepository } from './repository.ts';

const knowledgeEvidence = ({ text, source, citation, version }: Memory) => ({ text, source, citation, version });
export type OnlineChatContext = {
  identity?: ReturnType<typeof chatIdentity>;
  personalMemories?: string[];
  roleKnowledge?: ReturnType<typeof knowledgeEvidence>[];
  goals?: ReturnType<typeof chatGoal>[];
};
export const onlineChatContextBytes = 6 * 1024;
const chatQueryUnits = 1200 * 16;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function contextQuery(question: string): string | undefined {
  // Keep the input and matching work bounded; use up to the first 120 UTF-16
  // units for retrieval. Test the full question before shortening it.
  if (typeof question !== 'string' || !question.trim() || question.length > chatQueryUnits ||
      /[\p{Cs}\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(question) || parseLocalChatCommand(question) || !safeChatFields([question])) return;
  return question.trim().replace(/\s+/gu, ' ').slice(0, knowledgeQueryLimit).replace(/[\uD800-\uDBFF]$/u, '');
}

/** Text-chat only. Produces data, never instructions, credentials, revisions or history for a model. */
export function buildOnlineChatContext(state: CharacterState, question: string, now: string): OnlineChatContext {
  const context: OnlineChatContext = {};
  const query = contextQuery(question);
  if (!query) return context;
  if (state.identity?.chatShare === true) {
    const fields = chatIdentity(state.identity);
    if (safeChatFields(Object.values(fields)) && bytes(fields) <= 1536) context.identity = fields;
  }
  const scoreOf = queryScorer(query);
  if (!scoreOf) return context;
  const records = state.memories.map(row => row.current);
  const personal = recallPersonal(query, records, record => record.chatShare === true && bytes(record.text) <= 768).map(record => record.text);
  const knowledge = recallKnowledgeRecords(query, records, now, record => record.chatShare === true && bytes(knowledgeEvidence(record)) <= 1248).map(knowledgeEvidence);
  const goals = state.goals.flatMap(goal => {
    if (goal.chatShare !== true || !safeChatFields([goal.title])) return [];
    const summary = chatGoal(goal), score = scoreOf([goal.title]);
    return score > 0 && bytes(summary) <= 384 ? [{ summary, score, goal }] : [];
  }).sort((a, b) => b.score - a.score || b.goal.updatedAt.localeCompare(a.goal.updatedAt) || a.goal.id.localeCompare(b.goal.id))
    .slice(0, knowledgeMatchLimit).map(item => item.summary);

  function append<K extends 'personalMemories' | 'roleKnowledge' | 'goals'>(key: K, values: NonNullable<OnlineChatContext[K]>) {
    for (const value of values) {
      const next = [...(context[key] ?? []), value] as NonNullable<OnlineChatContext[K]>;
      if (bytes({ ...context, [key]: next }) <= onlineChatContextBytes) context[key] = next;
    }
  }
  append('personalMemories', personal);
  append('roleKnowledge', knowledge);
  append('goals', goals);
  return context;
}

type ChatContextSnapshot = { characterRevision: number; context: OnlineChatContext };

/** The synchronous callback can start transport while authorization is ordered
 * with record edits and instance deletion. Never wait for network in this queue. */
export function withOnlineChatContext<T>(workspace: PetWorkspace, repository: CharacterRepository, petID: string, question: string,
  use: (snapshot: ChatContextSnapshot) => T, now?: string) {
  return workspace.withRegisteredInstance(petID, async id => {
    const state = await repository.readForOnlineChat(id);
    return use({ characterRevision: state.revision, context: buildOnlineChatContext(state, question, now ?? new Date().toISOString()) });
  });
}

export function prepareOnlineChatContext(workspace: PetWorkspace, repository: CharacterRepository, petID: string, question: string, now?: string) {
  return withOnlineChatContext(workspace, repository, petID, question, snapshot => snapshot, now);
}
