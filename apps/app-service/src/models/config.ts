import { isModelLoopback, normalizeModelBaseURL } from '../../../../packages/contracts/src/models.ts';
import { validModelCapabilities } from '../../../../packages/contracts/src/model-capabilities.ts';
import { createHash } from 'node:crypto';
import { ModelError } from './errors.ts';
import { MODEL_PROTOCOLS, type Compatibility, type ModelConfiguration, type ModelConnection, type ModelEntry, type ModelProtocol, type ModelPurpose, type ModelRoute, type ModelSelection } from './types.ts';
const invalid = (): never => { throw new ModelError('invalid_configuration'); };
const record = (x: unknown): x is Record<string,unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const keys = (x: Record<string,unknown>, allowed: string[]) => Object.keys(x).every(key => allowed.includes(key));
const text = (x: unknown, max: number): x is string => typeof x === 'string' && !!x.trim() && Buffer.byteLength(x) <= max && !/[\u0000-\u001f\u007f]/.test(x);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const capacity = (x: unknown) => x === undefined || (Number.isInteger(x) && Number(x) > 0 && Number(x) <= 2_147_483_647);
const oneOf = (x: unknown, allowed: readonly string[]): boolean => typeof x === 'string' && allowed.includes(x);
const revision = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
export function validateBaseURL(value: unknown, protocol: ModelProtocol): string {
  return normalizeModelBaseURL(value, protocol) ?? invalid();
}
function compatible(value: unknown, protocol: ModelProtocol): value is Compatibility {
  return record(value) && keys(value,protocol === 'chat-completions' ? ['outputTokenField'] : []) && (value.outputTokenField === undefined || oneOf(value.outputTokenField,['max_tokens','max_completion_tokens']));
}
export function validateConfiguration(value: unknown): ModelConfiguration {
  let bytes: number; try { bytes=Buffer.byteLength(JSON.stringify(value)); } catch { return invalid(); }
  if (bytes>1_048_576 || !record(value) || !keys(value,['schemaVersion','revision','defaultConnectionID','connections']) || value.schemaVersion !== 2 || !revision(value.revision) || !Array.isArray(value.connections) || value.connections.length>32) return invalid();
  const ids=new Set<string>(), credentials=new Set<string>();
  for(const c of value.connections) {
    if (!record(c) || !keys(c,['id','revision','displayName','preset','apiProtocol','baseURL','authMode','credentialRef','models','defaultModelEntryID','compatibility']) || !identifier(c.id) || ids.has(c.id) || !revision(c.revision) || !text(c.displayName,128) || !oneOf(c.preset,['openai','deepseek','anthropic','google','custom']) || !MODEL_PROTOCOLS.includes(c.apiProtocol as ModelProtocol)) return invalid();
    ids.add(c.id);
    const protocol=c.apiProtocol as ModelProtocol;
    const base=validateBaseURL(c.baseURL,protocol);
    if (!compatible(c.compatibility,protocol) || !oneOf(c.authMode,['apiKey','none']) || (c.authMode === 'apiKey' ? c.credentialRef !== undefined && (!identifier(c.credentialRef) || credentials.has(c.credentialRef)) : c.credentialRef !== undefined || !isModelLoopback(new URL(base))) || !Array.isArray(c.models) || !c.models.length || c.models.length>33) return invalid();
    if (typeof c.credentialRef === 'string') credentials.add(c.credentialRef);
    const entries=new Set<string>(), models=new Set<string>();
    for(const m of c.models) {
      if (!record(m) || !keys(m,['entryID','modelID','displayName','contextWindow','maxOutputTokens','reasoningEffort','inputModalities','capabilities','compatibility']) || !identifier(m.entryID) || entries.has(m.entryID) || !text(m.modelID,256) || /\s/.test(m.modelID) || models.has(m.modelID) || !text(m.displayName,128) || !capacity(m.contextWindow) || !capacity(m.maxOutputTokens) || !compatible(m.compatibility,protocol) || !validModelCapabilities({ protocol, baseURL: base, modelID: m.modelID as string, ...(m.reasoningEffort === undefined ? {} : { reasoningEffort: m.reasoningEffort as import('../../../../packages/contracts/src/models.ts').ReasoningEffort }), ...(m.inputModalities === undefined ? {} : { inputModalities: m.inputModalities as import('../../../../packages/contracts/src/models.ts').InputModality[] }) }) || !record(m.capabilities) || !keys(m.capabilities,['tools']) || !record(m.capabilities.tools) || !keys(m.capabilities.tools,['status','source']) || !oneOf(m.capabilities.tools.status,['unknown','supported','unsupported']) || !oneOf(m.capabilities.tools.source,['user','preset','discovery'])) return invalid();
      entries.add(m.entryID);models.add(m.modelID);
    }
    if (!identifier(c.defaultModelEntryID) || !entries.has(c.defaultModelEntryID)) return invalid();
  }
  if (value.defaultConnectionID !== null && (!identifier(value.defaultConnectionID) || !ids.has(value.defaultConnectionID))) return invalid();
  return structuredClone(value) as ModelConfiguration;
}
export function resolveRoute(configuration: ModelConfiguration, selection: ModelSelection | undefined, purpose: ModelPurpose): ModelRoute {
  const config=validateConfiguration(configuration);
  if (!['text-chat','speech'].includes(purpose)) throw new ModelError('invalid_request');
  const c=config.connections.find(c=>c.id === (selection?.connectionID ?? config.defaultConnectionID));
  const m=c?.models.find(m=>m.entryID === (selection?.modelEntryID ?? c.defaultModelEntryID));
  if (!c || !m) throw new ModelError(selection ? 'route_changed' : 'not_configured');
  const route = routeFor(config.revision,c,m,purpose);
  if (selection && selection.fingerprint !== route.fingerprint) throw new ModelError('route_changed');
  return route;
}

// Explicit API model IDs only. Never infer capabilities for compatible gateways or custom endpoints
// from a model-name prefix; the provider may map the same ID to a different model.
const openAIResponsesVision = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-5', 'gpt-5-mini']);

/** Build a route from a connection and model taken from a validated snapshot. */
export function routeFor(revision: number, c: ModelConnection, m: ModelEntry, purpose: ModelPurpose): ModelRoute {
  const baseURL=validateBaseURL(c.baseURL,c.apiProtocol);
  const compatibility={...c.compatibility,...m.compatibility};
  const reasoningEffort = m.reasoningEffort;
  const knownVision = c.apiProtocol === 'responses' && baseURL === 'https://api.openai.com/v1' && openAIResponsesVision.has(m.modelID);
  const inputModalities = m.inputModalities ? [...m.inputModalities] : knownVision ? ['image', 'pdf'] as const : undefined;
  const fingerprint=createHash('sha256').update(JSON.stringify([c.id,c.apiProtocol,baseURL,c.authMode,c.credentialRef ?? null,m.entryID,m.modelID,compatibility,reasoningEffort ?? null,inputModalities ?? null])).digest('hex');
  return {connectionID:c.id,modelEntryID:m.entryID,fingerprint,configurationRevision:revision,connectionRevision:c.revision,apiProtocol:c.apiProtocol,baseURL,authMode:c.authMode,...(c.credentialRef ? {credentialRef:c.credentialRef} : {}),modelID:m.modelID,compatibility,...(reasoningEffort ? {reasoningEffort} : {}),...(inputModalities ? {inputModalities:Object.freeze(inputModalities)} : {}),tools:m.capabilities.tools.status,purpose,tokenBudget:Math.min(purpose==='speech'?160:2048,m.maxOutputTokens ?? 2048),timeoutMs:purpose==='speech'?25_000:60_000};
}
