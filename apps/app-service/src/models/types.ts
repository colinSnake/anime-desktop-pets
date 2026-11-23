/** 服务内部契约；凭证引用、在线路由快照和原生签名不向 renderer 暴露。 */
import type { Compatibility, InputModality, ModelDraft, ModelProtocol, ReasoningEffort, ToolCapability } from '../../../../packages/contracts/src/models.ts';
import type { ValidatedChatAttachment } from '../../../../packages/contracts/src/chat-attachments.ts';
export { MODEL_PROTOCOLS } from '../../../../packages/contracts/src/models.ts';
export type { Compatibility, ModelEntry, ModelProtocol, ToolCapability } from '../../../../packages/contracts/src/models.ts';
export type ModelPurpose = 'text-chat' | 'speech' | 'agent-task';
export type ModelConnection = ModelDraft & { revision: number; credentialRef?: string };
export type ModelConfiguration = { schemaVersion: 2; revision: number; defaultConnectionID: string | null; connections: ModelConnection[] };
export type ModelSelection = { connectionID: string; modelEntryID: string; fingerprint: string };
export type ModelRoute = ModelSelection & { configurationRevision: number; connectionRevision: number; apiProtocol: ModelProtocol; baseURL: string; authMode: 'apiKey' | 'none'; credentialRef?: string; modelID: string; compatibility: Compatibility; reasoningEffort?: ReasoningEffort; inputModalities?: readonly InputModality[]; tools: ToolCapability['status']; purpose: ModelPurpose; tokenBudget: number; timeoutMs: number };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ToolDefinition = { name: string; description: string; parameters: JsonObject };
export type ToolCall = { id: string; name: string; arguments: JsonObject };
export type ModelMessage = { role: 'user'; text: string; attachments?: ValidatedChatAttachment[] } | { role: 'assistant'; text: string; toolCalls?: ToolCall[] } | { role: 'tool'; toolCallID: string; text: string };
export type ModelInput = { messages: ModelMessage[]; system?: string; referenceData?: JsonObject; tools?: ToolDefinition[] };
export type ModelReply = { message: Extract<ModelMessage, {role:'assistant'}>; stop: 'end' | 'length' | 'tools' | 'refused'; usage: { inputTokens?: number; outputTokens?: number } };
export type DiscoveredModel = { modelID: string; displayName: string; contextWindow?: number; maxOutputTokens?: number; tools: 'unknown' };
export type DiscoveryPage = { models: DiscoveredModel[]; next?: string; truncated?: boolean };
export type DiscoveryResult = { models: DiscoveredModel[]; truncated: boolean };
export type EncodedRequest = { path: string; headers: Record<string,string>; body: JsonObject };
export interface ProtocolAdapter {
  encode(route: ModelRoute, input: ModelInput): EncodedRequest;
  decode(route: ModelRoute, raw: unknown): ModelReply;
  discovery(cursor?: string): { path: string; headers: Record<string,string> };
  decodeDiscovery(raw: unknown, firstPage?: boolean): DiscoveryPage;
}
