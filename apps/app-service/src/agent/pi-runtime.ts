import { isDeepStrictEqual } from 'node:util';
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { validateToolArguments } from '@earendil-works/pi-ai/utils/validation';
import type { ValidatedChatAttachment } from '../../../../packages/contracts/src/chat-attachments.ts';
import { validChatReplyText } from '../../../../packages/contracts/src/online-chat.ts';
import { ModelError } from '../models/errors.ts';
import type { JsonObject, ModelInput, ModelMessage, ModelReply, ToolDefinition } from '../models/types.ts';
import type { TextChatRuntime } from './text-chat-runtime.ts';

export type PiTool = ToolDefinition & { execute(args: JsonObject, signal: AbortSignal): string | Promise<string> };
type PiRun = {
  text: string;
  system?: string;
  tools?: readonly PiTool[];
  attachments?: ValidatedChatAttachment[];
  signal: AbortSignal;
  complete(input: ModelInput, signal: AbortSignal): Promise<ModelReply>;
  acceptReply?: (text: string) => boolean;
  afterTools?: () => Promise<void>;
};

// A routing sentinel, not a real Pi provider. Real routes and credentials stay in ModelManagement.
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model: Model<Api> = {
  id: 'adpets-turn', name: 'AdPets turn', provider: 'adpets', api: 'adpets', baseUrl: '',
  input: ['text'], cost: zeroCost, reasoning: false, contextWindow: 16384, maxTokens: 8192,
};
const invalid = (): never => { throw new ModelError('invalid_response'); };
function check(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof ModelError ? signal.reason : new ModelError('cancelled');
}

/** Pi owns loop/tool sequencing. Only validated, round-local material enters the product provider callback. */
export async function runPiAgent({ text, system, tools = [], attachments, signal, complete, acceptReply = validChatReplyText, afterTools }: PiRun): Promise<string> {
  check(signal);
  const definitions = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const byName = new Map(definitions.map(tool => [tool.name, tool]));
  const transcript: ModelMessage[] = [{ role: 'user', text, ...(attachments?.length && { attachments }) }];
  const callIDs = new Set<string>();
  let requests = 0, remaining = 3300, final: string | undefined;
  let failure: { error: unknown } | undefined;
  const spend = (value: string) => { if ((remaining -= value.length) < 0) invalid(); };
  const agentTools: AgentTool[] = tools.map(({ name, description, parameters, execute }) => ({
    name, label: name, description, parameters,
    execute: async (toolCallID, args) => {
      try {
        check(signal);
        if (failure) throw failure.error;
        const result = await execute(args as JsonObject, signal);
        check(signal);
        if (typeof result !== 'string') invalid();
        spend(result);
        transcript.push({ role: 'tool', toolCallID, text: result });
        return { content: [{ type: 'text', text: result }], details: undefined };
      } catch (error) {
        failure ??= { error };
        throw new ModelError('invalid_response');
      }
    },
  }));
  const agent = new Agent({
    initialState: { model, systemPrompt: system, tools: agentTools }, toolExecution: 'sequential',
    identity: { attribution: null },
    streamFn: async () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: 'error',
        usage: { ...zeroCost, totalTokens: 0, cost: { ...zeroCost, total: 0 } },
      };
      try {
        check(signal);
        if (failure) throw failure.error;
        if (requests >= 6) invalid();
        if (requests && afterTools) { await afterTools(); check(signal); }
        requests++;
        const reply = await complete({ messages: [...transcript], ...(system ? { system } : {}), ...(definitions.length ? { tools: definitions } : {}) }, signal);
        check(signal);
        const next = reply.message.toolCalls ?? [];
        if (reply.stop === 'end' && !next.length && acceptReply(reply.message.text)) {
          final = reply.message.text.trim();
          message.stopReason = 'stop';
          message.content.push({ type: 'text', text: final });
        } else {
          if (reply.stop !== 'tools' || !next.length || requests >= 6 || callIDs.size + next.length > 8 || transcript.length + next.length + 1 > 12) invalid();
          spend(reply.message.text);
          for (const call of next) {
            const tool = byName.get(call.name);
            if (!tool || !call.id || callIDs.has(call.id)) throw new ModelError('invalid_response');
            const block = { type: 'toolCall' as const, ...call };
            // Pi can coerce arguments by default; the app's tool contract does not permit that.
            try { if (!isDeepStrictEqual(validateToolArguments(tool, block), call.arguments)) invalid(); }
            catch { invalid(); }
            callIDs.add(call.id);
            message.content.push(block);
          }
          // Native protocol continuation lives in a private WeakMap keyed by this exact object.
          transcript.push(reply.message);
          message.stopReason = 'toolUse';
        }
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        failure ??= { error };
        const reason = signal.aborted ? 'aborted' : 'error';
        stream.push({ type: 'error', reason, error: { ...message, content: [], stopReason: reason, errorMessage: 'adpets_turn_failed' } });
      }
      return stream;
    },
  });
  const abort = () => agent.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await agent.prompt(text);
    check(signal);
    if (failure) throw failure.error;
    return final ?? invalid();
  } finally { signal.removeEventListener('abort', abort); }
}

export function createPiTextRuntime(): TextChatRuntime {
  return (text, complete, signal) => runPiAgent({ text, signal, complete: async ({ messages }) => ({
    message: { role: 'assistant', text: await complete(messages[0]!.text) }, stop: 'end', usage: {},
  }) });
}
