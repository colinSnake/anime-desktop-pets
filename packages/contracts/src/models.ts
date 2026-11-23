/** Local model management. Only save accepts a new Key; no reads return Key material or private references. */
export const MODEL_PROTOCOLS = ['chat-completions', 'responses', 'anthropic', 'gemini'] as const;
export type ModelProtocol = typeof MODEL_PROTOCOLS[number];
export const isModelLoopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
/** Shared form/service validation for adapter base addresses, not full request endpoints. */
export function normalizeModelBaseURL(value: unknown, protocol: ModelProtocol): string | undefined {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).byteLength > 2048 ||
    /[\x00-\x1f\x7f\s\\]|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)|\/(?:\.|\.\.)(?:\/|$)/i.test(value)) return;
  let url: URL;
  try { url = new URL(value); } catch { return; }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isModelLoopback(url))) || !url.hostname ||
    url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) return;
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|responses|messages)$/.test(path) || /:generateContent$/.test(path) ||
    (protocol === 'gemini' && !/\/v1(?:beta)?$/.test(path))) return;
  return `${url.origin}${path}`;
}
export type Compatibility = { outputTokenField?: 'max_tokens' | 'max_completion_tokens' };
export type ToolCapability = { status: 'unknown' | 'supported' | 'unsupported'; source: 'user' | 'preset' | 'discovery' };
export type ModelEntry = { entryID: string; modelID: string; displayName: string; contextWindow?: number; maxOutputTokens?: number; capabilities: { tools: ToolCapability }; compatibility: Compatibility };
export type ModelDraft = { id: string; displayName: string; preset: 'openai' | 'deepseek' | 'anthropic' | 'google' | 'custom'; apiProtocol: ModelProtocol; baseURL: string; authMode: 'apiKey' | 'none'; models: ModelEntry[]; defaultModelEntryID: string; compatibility: Compatibility };
export type SavedModelConnection = ModelDraft & { revision: number; credentialState: 'missing' | 'reference-present' | 'not-required' };
export type SavedModelConfiguration = { revision: number; defaultConnectionID: string | null; connections: SavedModelConnection[] };
export type ModelEdit = { connection: ModelDraft; expectedRevision: number };
export const MODEL_API_KEY_MAX_LENGTH = 8192;
export const validModelAPIKey = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= MODEL_API_KEY_MAX_LENGTH && !/[^\x21-\x7e]/.test(value);
export type ModelSave = ModelEdit & { credential: { kind: 'keep' | 'remove' } | { kind: 'replace'; key: string } };
export type ModelDefault = { expectedRevision: number; connectionID: string; entryID: string } | { expectedRevision: number; connectionID: null };
export type ModelRemove = { expectedRevision: number; connectionID: string; replacementDefault?: string | null };
export const MODEL_MANAGEMENT_ERRORS = ['invalid_configuration', 'configuration_conflict', 'credentials_unavailable', 'storage_unavailable', 'publication_uncertain', 'busy', 'unavailable'] as const;
export type ModelManagementFailure = typeof MODEL_MANAGEMENT_ERRORS[number];
export type ModelCleanup = 'not_needed' | 'removed' | 'pending' | 'retained_uncertain';
export type ModelManagementReply = { version: 1 } & (
  { ok: true; configuration: SavedModelConfiguration; durability?: 'confirmed' | 'unconfirmed'; retainedCredentialVersions?: boolean; writesBlocked?: true } |
  { ok: false; error: ModelManagementFailure; credentialCleanup?: ModelCleanup }
);
export type ModelWorkspaceError = 'write_outcome_unknown';
export type ModelWorkspaceReply = ModelManagementReply | { version: 1; ok: false; error: ModelWorkspaceError };
export type ModelDiscoveryInput = { connectionID: string; expectedRevision: number };
export type ModelDiscoveryRequest = ModelDiscoveryInput & { operationID: string };
export type ModelCandidate = { modelID: string; displayName: string };
export const MODEL_DISCOVERY_ERRORS = ['invalid_configuration', 'configuration_conflict', 'credentials_unavailable', 'storage_unavailable', 'publication_uncertain', 'busy', 'authentication_failed', 'rate_limited', 'invalid_response', 'response_too_large', 'upstream_unavailable', 'timed_out', 'cancelled', 'unavailable'] as const;
export type ModelDiscoveryError = typeof MODEL_DISCOVERY_ERRORS[number];
export type ModelDiscoveryReply = { version: 1 } & (
  { ok: true; connectionID: string; revision: number; candidates: ModelCandidate[]; truncated: boolean } |
  { ok: false; error: ModelDiscoveryError }
);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const validDiscoveryOperation = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
export function validDiscoveryInput(value: unknown): value is ModelDiscoveryInput {
  return object(value) && Object.keys(value).length === 2 && typeof value.connectionID === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.connectionID) &&
    typeof value.expectedRevision === 'number' && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision > 0;
}
export function validDiscoveryCandidate(value: unknown): value is ModelCandidate {
  const text = (value: unknown, bytes: number): value is string => typeof value === 'string' && !!value.trim() &&
    !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) && new TextEncoder().encode(value).byteLength <= bytes;
  return object(value) && Object.keys(value).length === 2 && text(value.modelID, 256) && !/\s/u.test(value.modelID) && text(value.displayName, 128);
}
export interface ModelsBridge {
  list(): Promise<ModelWorkspaceReply>;
  save(input: ModelSave): Promise<ModelWorkspaceReply>;
  setDefault(input: ModelDefault): Promise<ModelWorkspaceReply>;
  remove(input: ModelRemove): Promise<ModelWorkspaceReply>;
  discover?(input: ModelDiscoveryRequest): Promise<ModelDiscoveryReply>;
  cancelDiscovery?(operationID: string): Promise<void>;
  testConnection?(input: import("./model-probe.ts").ModelProbeOperation): Promise<import("./model-probe.ts").ModelProbeReply>;
  cancelConnectionTest?(operationID: string): Promise<void>;
}
