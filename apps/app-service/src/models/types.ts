/** 服务内部契约；不向 renderer 暴露凭证、路由地址或原生签名。 */
export const MODEL_PROTOCOLS = ['chat-completions', 'responses', 'anthropic', 'gemini'] as const;
export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
export type ModelPurpose = 'text-chat' | 'speech';
export type Compatibility = { outputTokenField?: 'max_tokens' | 'max_completion_tokens' };
export type ToolCapability = { status: 'unknown' | 'supported' | 'unsupported'; source: 'user' | 'preset' | 'discovery' };
export type ModelEntry = { entryID: string; modelID: string; displayName: string; contextWindow?: number; maxOutputTokens?: number; capabilities: { tools: ToolCapability }; compatibility: Compatibility };
export type ModelConnection = { id: string; revision: number; displayName: string; preset: 'openai' | 'deepseek' | 'anthropic' | 'google' | 'custom'; apiProtocol: ModelProtocol; baseURL: string; authMode: 'apiKey' | 'none'; credentialRef?: string; models: ModelEntry[]; defaultModelEntryID: string; compatibility: Compatibility };
export type ModelConfiguration = { schemaVersion: 2; revision: number; defaultConnectionID: string | null; connections: ModelConnection[] };
export type ModelSelection = { connectionID: string; modelEntryID: string; fingerprint: string };
export type ModelRoute = ModelSelection & { configurationRevision: number; connectionRevision: number; apiProtocol: ModelProtocol; baseURL: string; authMode: 'apiKey' | 'none'; credentialRef?: string; modelID: string; compatibility: Compatibility; tools: ToolCapability['status']; purpose: ModelPurpose; tokenBudget: number; timeoutMs: number };
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ToolDefinition = { name: string; description: string; parameters: JsonObject };
export type ToolCall = { id: string; name: string; arguments: JsonObject };
export type ModelMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; toolCalls?: ToolCall[] } | { role: 'tool'; toolCallID: string; text: string };
export type ModelInput = { messages: ModelMessage[]; system?: string; tools?: ToolDefinition[] };
export type ModelReply = { message: Extract<ModelMessage, {role:'assistant'}>; stop: 'end' | 'length' | 'tools' | 'refused'; usage: { inputTokens?: number; outputTokens?: number } };
export type DiscoveredModel = { modelID: string; displayName: string; contextWindow?: number; maxOutputTokens?: number; tools: 'unknown' };
export type DiscoveryPage = { models: DiscoveredModel[]; next?: string; truncated?: boolean };
export type DiscoveryResult = { models: DiscoveredModel[]; truncated: boolean };
export type EncodedRequest = { path: string; headers: Record<string,string>; body: JsonObject };
export interface ProtocolAdapter {
  encode(route: ModelRoute, input: ModelInput): EncodedRequest;
  decode(route: ModelRoute, raw: unknown): ModelReply;
  discovery(cursor?: string): { path: string; headers: Record<string,string> };
  decodeDiscovery(raw: unknown): DiscoveryPage;
}
