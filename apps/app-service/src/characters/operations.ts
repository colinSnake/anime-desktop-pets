import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CharacterError, HISTORY_LIMIT, MEMORY_LIMIT, GOAL_LIMIT, invalid, credentialLike, characterIsEmpty,
  type CharacterState, type Command, type IdentityDraft, type MemoryDraft, type GoalDraft, type Memory, type Goal } from './records.ts';

import { chatMemoryDraft, knowledgeCollision, normalizeMemoryText } from '../../../../packages/contracts/src/character-records.ts';
import { chatIdentity, safeChatFields } from './chat-context-policy.ts';
import type { ChatShare } from '../../../../packages/contracts/src/characters.ts';
import { knowledgeBatchIssue } from '../../../../packages/contracts/src/knowledge-import.ts';

const missing = () => new CharacterError('character_record_not_found');
const limit = () => new CharacterError('character_limit');
const instant = (now: string, previous?: string) => previous && previous > now ? previous : now;
const stamped = (now: string, old?: { revision: number; createdAt: string; updatedAt: string }) => ({
  revision: (old?.revision ?? 0) + 1, createdAt: old?.createdAt ?? now, updatedAt: instant(now, old?.updatedAt),
});
function archive<T extends ChatShare>(trail: T[], record: T) {
  const snapshot = { ...record };
  delete snapshot.chatShare;
  trail.push(snapshot);
  if (trail.length > HISTORY_LIMIT) trail.shift();
}
const expired = (m: MemoryDraft, now: string) => m.expiresAt !== undefined && m.expiresAt <= now;
const memoryContent = ({ kind, text, source, citation, version, expiresAt }: MemoryDraft): MemoryDraft => ({ kind, text, source, citation, version, ...(expiresAt === undefined ? {} : { expiresAt }) });
function review(value: Memory, all: Memory[], now: string) {
  if (expired(value, now)) throw new CharacterError('memory_expired');
  const reference = knowledgeCollision(value);
  for (const other of all) {
    if (other.id === value.id || other.status !== 'confirmed' || other.kind !== value.kind || expired(other, now)) continue;
    if (normalizeMemoryText(other.text) === normalizeMemoryText(value.text)) throw new CharacterError('memory_duplicate');
    if (reference !== undefined && reference === knowledgeCollision(other)) throw new CharacterError('knowledge_conflict');
  }
}
function identityDraft({ name, role, background, personality, values, motivations, relationship, speakingStyle, knowledgeScope, boundaries }: IdentityDraft): IdentityDraft {
  return { name: name.trim(), role, background, personality, values, motivations, relationship, speakingStyle, knowledgeScope, boundaries };
}
function goalDraft(value: GoalDraft, now: string, previous?: Goal): Goal {
  const steps = value.steps.map(step => {
    if (step.id && !previous?.steps.some(current => current.id === step.id)) throw invalid();
    return { ...step, id: step.id ?? randomUUID() };
  });
  return { ...value, ...stamped(now, previous), id: previous?.id ?? randomUUID(), steps };
}

function sharing(record: ChatShare, enabled: boolean, safe: () => boolean) {
  if (enabled && !safe()) throw new CharacterError('credential_like_memory');
  if ((record.chatShare === true) === enabled) return false;
  if (enabled) record.chatShare = true;
  else delete record.chatShare;
  return true;
}

const goalContent = ({ title, details, status, steps }: Goal) => ({ title, details, status, steps });

export function transition(state: CharacterState, command: Command, now: string): void {
  switch (command.type) {
    case 'importLegacy': {
      if (!characterIsEmpty(state)) throw new CharacterError('character_conflict');
      const { identity, memories, goals } = command.value;
      state.identity = identity ? { ...identityDraft(identity), ...stamped(now) } : null;
      state.memories = memories.map(draft => ({ current: { ...memoryContent(draft), ...stamped(now), id: randomUUID(), status: 'candidate' }, history: [] }));
      state.goals = goals.map(draft => goalDraft(draft, now));
      state.legacyImport = true;
      break;
    }
    case 'undoLegacyImport':
      if (!state.legacyImport) throw new CharacterError('character_conflict');
      state.identity = null;
      state.memories = [];
      state.goals = [];
      break;
    case 'setIdentityChatShare': {
      const current = state.identity;
      if (!current) throw missing();
      if (!sharing(current, command.enabled, () => safeChatFields(Object.values(chatIdentity(current))))) return;
      break;
    }
    case 'setMemoryChatShare': {
      const current = state.memories.find(row => row.current.id === command.id)?.current;
      if (!current) throw missing();
      if (command.enabled) {
        if (current.status !== 'confirmed') throw invalid();
        review(current, state.memories.map(row => row.current), now);
      }
      if (!sharing(current, command.enabled, () => !credentialLike(current))) return;
      break;
    }
    case 'setGoalChatShare': {
      const goal = state.goals.find(item => item.id === command.id);
      if (!goal) throw missing();
      if (!sharing(goal, command.enabled, () => safeChatFields([goal.title]))) return;
      break;
    }
    case 'saveIdentity': case 'restoreIdentity': {
      const value = command.type === 'saveIdentity' ? command.value : state.identityHistory.find(row => row.revision === command.revision);
      if (!value) throw missing();
      const draft = identityDraft(value);
      if (command.type === 'saveIdentity' && state.identity && isDeepStrictEqual(draft, identityDraft(state.identity))) return;
      if (state.identity) archive(state.identityHistory, state.identity);
      state.identity = { ...draft, ...stamped(now, state.identity ?? undefined) };
      break;
    }
    case 'saveChatMemory': {
      const draft = chatMemoryDraft(command.value);
      if (credentialLike(draft)) throw new CharacterError('credential_like_memory');
      const key = normalizeMemoryText(draft.text);
      if (state.memories.some(({ current }) => current.id === command.id || (current.kind !== '知识' && normalizeMemoryText(current.text) === key)))
        throw new CharacterError('memory_duplicate');
      if (state.memories.length >= MEMORY_LIMIT) throw limit();
      state.memories.push({ current: { ...draft, ...stamped(now), id: command.id, status: 'confirmed', confirmedAt: now }, history: [] });
      break;
    }
    case 'addMemory': {
      if (credentialLike(command.value)) throw new CharacterError('credential_like_memory');
      if (state.memories.length >= MEMORY_LIMIT) throw limit();
      state.memories.push({ current: { ...memoryContent(command.value), ...stamped(now), id: randomUUID(), status: 'candidate' }, history: [] });
      break;
    }
    case 'addKnowledgeBatch': {
      const issue = knowledgeBatchIssue(command.value, state.memories.map(row => row.current), now);
      if (issue) throw new CharacterError(({ limit: 'character_limit', 'credential-like': 'credential_like_memory', expired: 'memory_expired',
        duplicate: 'memory_duplicate', 'knowledge-conflict': 'knowledge_conflict' } as const)[issue]);
      for (const draft of command.value) state.memories.push({ current: { ...memoryContent(draft), ...stamped(now), id: randomUUID(), status: 'candidate' }, history: [] });
      break;
    }
    case 'editMemory': case 'restoreMemory': case 'confirmMemory': case 'withdrawMemory': case 'deleteMemory': {
      const index = state.memories.findIndex(row => row.current.id === command.id), row = state.memories[index];
      if (!row) throw missing();
      const current = row.current;
      if (command.type === 'deleteMemory') state.memories.splice(index, 1);
      else if (command.type === 'confirmMemory') {
        const confirmedAt = instant(now, current.updatedAt);
        review(current, state.memories.map(m => m.current), confirmedAt);
        if (current.status === 'confirmed') return;
        row.current = { ...current, status: 'confirmed', confirmedAt };
      } else if (command.type === 'withdrawMemory') {
        if (current.status === 'candidate') return;
        const { confirmedAt: _confirmedAt, chatShare: _chatShare, ...unconfirmed } = current;
        row.current = { ...unconfirmed, status: 'candidate' };
      } else if (command.type === 'editMemory' || command.type === 'restoreMemory') {
        const value = command.type === 'editMemory' ? command.value : row.history.find(m => m.revision === command.revision);
        if (!value) throw missing();
        if (credentialLike(value)) throw new CharacterError('credential_like_memory');
        const draft = memoryContent(value);
        if (command.type === 'editMemory' && isDeepStrictEqual(draft, memoryContent(current))) return;
        archive(row.history, current);
        row.current = { ...draft, ...stamped(now, current), id: current.id, status: 'candidate' };
      }
      break;
    }
    case 'addGoal':
      if (state.goals.length >= GOAL_LIMIT) throw limit();
      state.goals.push(goalDraft(command.value, now));
      break;
    case 'editGoal': case 'deleteGoal': {
      const index = state.goals.findIndex(g => g.id === command.id), goal = state.goals[index];
      if (!goal) throw missing();
      if (command.type === 'editGoal') {
        const updated = goalDraft(command.value, now, goal);
        if (isDeepStrictEqual(goalContent(updated), goalContent(goal))) return;
        state.goals[index] = updated;
      } else state.goals.splice(index, 1);
      break;
    }
  }
  if (command.type !== 'importLegacy') delete state.legacyImport;
  state.revision++;
}
