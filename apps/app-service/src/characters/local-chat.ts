import type { FastifyInstance } from 'fastify';
import { credentialLike } from '../../../../packages/contracts/src/character-records.ts';
import { isLocalChatInput, localChatRequestBytes, localChatStatus, localChatTextLimit,
  type LocalChatError, type LocalChatIntent, type LocalChatResult } from '../../../../packages/contracts/src/local-chat.ts';
import { WorkspaceError } from '../workspace-store.ts';
import type { PetWorkspace } from '../pet-workspace.ts';
import { recallKnowledge, recallPersonal } from './knowledge-recall.ts';
import type { CharacterState } from './records.ts';
import type { CharacterRepository } from './repository.ts';

const safe = (text: string) => !credentialLike({ kind: '事实', text, source: '', citation: '', version: '' });
function boundedLines(title: string, lines: string[], empty: string): string {
  let result = title;
  for (const line of lines) if (result.length + line.length + 1 <= localChatTextLimit && safe(line)) result += `\n${line}`;
  return result === title ? empty : result;
}

export function buildLocalChatAnswer(intent: LocalChatIntent, state: CharacterState, now: string, displayName?: string): string {
  if (intent.intent === 'identity') {
    const identity = state.identity;
    if (!identity) {
      const name = displayName?.trim();
      const introduction = name && safe(name) ? `我是${name}，你当前选择的桌宠。` : '我是你当前选择的桌宠。';
      return `${introduction}\n尚未设置本机身份，可在「聊天 → ⋯ → 桌宠 Agent → 身份」中设置。`;
    }
    if (!safe(identity.name) || !safe(identity.role)) return '当前桌宠暂无可展示的本机身份。';
    return `我是${identity.name}。${identity.role ? `\n角色：${identity.role}` : ''}`;
  }
  if (intent.intent === 'goals') {
    const goals = state.goals.filter(goal => safe(goal.title)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 3);
    return boundedLines('最近保存的目标进度：', goals.map(goal => {
      const done = goal.steps.filter(step => step.isComplete).length;
      const next = goal.status === '进行中' ? goal.steps.find(step => !step.isComplete) : undefined;
      return `• ${goal.title}（${goal.status}，${done}/${goal.steps.length} 步已完成）${next && safe(next.text) ? `；下一步：${next.text}` : ''}`;
    }), '当前桌宠暂无可展示的已保存目标。');
  }
  if (!('query' in intent)) return '当前查询不可用。';
  const records = state.memories.map(row => row.current);
  if (intent.intent === 'memory') return boundedLines('找到以下本机个人记忆：',
    recallPersonal(intent.query, records).map(memory => `• ${memory.text}`), '当前桌宠没有匹配的已确认个人记忆。');
  const matches = recallKnowledge(intent.query, records, now).map(id => records.find(record => record.id === id)!);
  return boundedLines('找到以下本机角色知识：', matches.map(memory => {
    const evidence = [memory.source && `来源：${memory.source}`, memory.citation && `引用：${memory.citation}`,
      memory.version && `版本：${memory.version}`].filter(Boolean).join('；');
    return `• ${memory.text}${evidence ? `\n  ${evidence}` : ''}`;
  }), '当前桌宠没有匹配的有效角色知识。');
}

export function registerLocalChatRoute(app: FastifyInstance, workspace: PetWorkspace, repository: CharacterRepository) {
  app.post<{ Params: { id: string } }>('/v1/characters/:id/chat/local-context', {
    schema: { querystring: { type: 'object', additionalProperties: false } }, bodyLimit: localChatRequestBytes,
  }, async (request, reply) => {
    const fail = (error: LocalChatError) => reply.code(localChatStatus[error]).send({ ok: false, error } satisfies LocalChatResult);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.hasOwn(body, 'petID')) return fail('invalid');
    const input = { ...body, petID: request.params.id };
    if (!isLocalChatInput(input)) return fail('invalid');
    try {
      return await workspace.withRegisteredInstance(input.petID, async (petID, instance) => {
        const state = await repository.read(petID);
        return { ok: true, petID, text: buildLocalChatAnswer(input, state, new Date().toISOString(), instance.displayName) } satisfies LocalChatResult;
      });
    } catch (error) {
      return fail(error instanceof WorkspaceError && error.code === 'not-found' ? 'not-found' : 'unavailable');
    }
  });
}
