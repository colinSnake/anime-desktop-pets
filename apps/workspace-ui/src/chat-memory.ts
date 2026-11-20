import type { CharacterRecordsBridge, RecordError } from '../../../packages/contracts/src/character-records.ts';

export type ChatMemoryBridge = Pick<CharacterRecordsBridge, 'readMemories' | 'saveChatMemory'>;
export type ChatMemoryProposal =
 | { state: 'ready'; text: string; revision: number }
 | { state: 'saving' | 'observed' | 'not-observed' | 'saved' | 'ignored'; text: string }
 | { state: 'reading' | 'uncertain'; text: string; revisionFloor?: number }
 | { state: 'blocked'; text: string; error: RecordError };

export const memoryProposalError: Partial<Record<RecordError, string>> = {
 conflict: '角色资料已变化。重新读取核对后，可再次确认保存。',
 busy: '角色资料正在更新。请先重新读取。',
 unavailable: '暂时无法读取或保存本机角色资料。',
 duplicate: '已有相同的个人记忆，或此发言已处理。未重复保存。',
 limit: '记忆已达上限，未保存。可以在桌宠 Agent 中管理。',
 'not-found': '这只桌宠已不存在，未继续操作。',
 'credential-like': '内容可能含凭证，不能保存为记忆。',
};
export const canReloadMemory = (error: RecordError) => error === 'conflict' || error === 'busy' || error === 'unavailable';
