import type { Goal, Memory, RecordSnapshot } from '../../../../packages/contracts/src/character-records.ts';
import type { ChatWorkspaceState } from '../chat-session.ts';
import type { IdentityEditorState } from './identity-editor.ts';
import type { MemoryMode } from './character-record-editors.ts';

export type AgentChatAvailability = Pick<ChatWorkspaceState, 'localAvailable' | 'online' | 'available'>;
type Records<T extends Memory | Goal> = { snapshot?: RecordSnapshot<T>; busy?: 'read' | 'write'; error?: string; needsRead?: boolean };
type ReadState = 'offline' | 'loading' | 'failed' | 'ready';
const readState = (state?: { snapshot?: object; busy?: string; error?: string }, needsRead = false): ReadState => {
  if (!state) return 'offline';
  if (state.busy === 'read') return 'loading';
  if (needsRead || (!state.snapshot && !!state.error)) return 'failed';
  return state.snapshot ? 'ready' : 'loading';
};
const summary = (state: ReadState, text: string) => state === 'ready' ? text : {
  offline: '资料服务未连接', loading: '正在读取…', failed: '读取失败',
}[state];

export function summarizePetAgent(identity: IdentityEditorState | undefined, memory: Records<Memory> | undefined,
  goals: Records<Goal> | undefined, chat: AgentChatAvailability, now = Date.now()) {
  const identityStatus = readState(identity, identity?.review === 'read-required');
  const memoryStatus = readState(memory, memory?.needsRead);
  const goalStatus = readState(goals, goals?.needsRead);
  const savedIdentity = identityStatus === 'ready' ? identity?.snapshot?.identity : undefined;
  const memories = memoryStatus === 'ready' ? memory?.snapshot?.records ?? [] : [];
  const savedGoals = goalStatus === 'ready' ? goals?.snapshot?.records ?? [] : [];
  const goal = savedGoals.find(entry => entry.status === '进行中') ?? savedGoals[0];
  const personal = memories.filter(entry => entry.kind !== '知识').length;
  const knowledge = memories.length - personal;
  const candidates = memories.filter(entry => entry.status === 'candidate' && (!entry.expiresAt || Date.parse(entry.expiresAt) > now));
  const memoryMode: MemoryMode = candidates.some(entry => entry.kind !== '知识') ? 'personal' : 'knowledge';
  const pending = candidates.length ? { count: candidates.length, memoryMode } : undefined;
  const capabilities = [...(chat.localAvailable ? ['本机查询'] : []), ...(chat.online && chat.available ? ['在线文字聊天'] : [])];
  const sharing = savedIdentity?.chatShare || memories.some(entry => entry.chatShare) || savedGoals.some(entry => entry.chatShare);
  const states = [identityStatus, memoryStatus, goalStatus];
  const checking = states.includes('loading') || identity?.busy === 'share' || memory?.busy === 'write' || goals?.busy === 'write';
  const privacy = checking ? '正在核对资料授权…' : sharing ? '已有资料获在线聊天授权' :
    states.every(status => status === 'ready') ? '资料仅本机' : '资料授权状态未确认';
  return { capabilities, pending, privacy, rows: {
    identity: summary(identityStatus, savedIdentity?.name ?? '尚未保存身份'),
    memory: summary(memoryStatus, memories.length ? `${personal} 条个人记忆 · ${knowledge} 条角色知识` : '暂无记忆或角色知识'),
    goals: summary(goalStatus, goal ? `${goal.title} · ${goal.steps.filter(step => step.isComplete).length} / ${goal.steps.length} 步` : '暂无目标'),
    capabilities: capabilities.join(' · ') || '当前无可用能力',
  } };
}
