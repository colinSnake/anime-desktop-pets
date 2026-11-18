import { createHash } from 'node:crypto';
import { ModelError } from './errors.ts';
import { MODEL_PROTOCOLS, type Compatibility, type ModelConfiguration, type ModelProtocol, type ModelPurpose, type ModelRoute, type ModelSelection } from './types.ts';
const invalid = (): never => { throw new ModelError('invalid_configuration'); };
const record = (x: unknown): x is Record<string,unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const keys = (x: Record<string,unknown>, allowed: string[]) => Object.keys(x).every(key => allowed.includes(key));
const text = (x: unknown, max: number): x is string => typeof x === 'string' && !!x.trim() && Buffer.byteLength(x) <= max && !/[\u0000-\u001f\u007f]/.test(x);
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x);
const capacity = (x: unknown) => x === undefined || (Number.isInteger(x) && Number(x) > 0 && Number(x) <= 2_147_483_647);
const oneOf = (x: unknown, allowed: readonly string[]): boolean => typeof x === 'string' && allowed.includes(x);
const revision = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
export const isLoopback = (url: URL): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
export function validateBaseURL(value: unknown, protocol: ModelProtocol): string {
  if (!text(value,2048) || /[\s\\]|%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value) || /\/(?:\.|\.\.)(?:\/|$)/.test(value)) return invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url))) || !url.hostname || url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) return invalid();
  const path = url.pathname.replace(/\/+$/, '');
  if (/\/(?:chat\/completions|responses|messages)$/.test(path) || /:generateContent$/.test(path)) return invalid();
  if (protocol === 'gemini' && !/\/v1(?:beta)?$/.test(path)) return invalid();
  return `${url.origin}${path}`;
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
    if (!compatible(c.compatibility,protocol) || !oneOf(c.authMode,['apiKey','none']) || (c.authMode === 'apiKey' ? c.credentialRef !== undefined && (!identifier(c.credentialRef) || credentials.has(c.credentialRef)) : c.credentialRef !== undefined || !isLoopback(new URL(base))) || !Array.isArray(c.models) || !c.models.length || c.models.length>33) return invalid();
    if (typeof c.credentialRef === 'string') credentials.add(c.credentialRef);
    const entries=new Set<string>(), models=new Set<string>();
    for(const m of c.models) {
      if (!record(m) || !keys(m,['entryID','modelID','displayName','contextWindow','maxOutputTokens','capabilities','compatibility']) || !identifier(m.entryID) || entries.has(m.entryID) || !text(m.modelID,256) || /\s/.test(m.modelID) || models.has(m.modelID) || !text(m.displayName,128) || !capacity(m.contextWindow) || !capacity(m.maxOutputTokens) || !compatible(m.compatibility,protocol) || !record(m.capabilities) || !keys(m.capabilities,['tools']) || !record(m.capabilities.tools) || !keys(m.capabilities.tools,['status','source']) || !oneOf(m.capabilities.tools.status,['unknown','supported','unsupported']) || !oneOf(m.capabilities.tools.source,['user','preset','discovery'])) return invalid();
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
  const baseURL=validateBaseURL(c.baseURL,c.apiProtocol);
  const compatibility={...c.compatibility,...m.compatibility};
  const fingerprint=createHash('sha256').update(JSON.stringify([c.id,c.apiProtocol,baseURL,c.authMode,c.credentialRef ?? null,m.entryID,m.modelID,compatibility])).digest('hex');
  if (selection && selection.fingerprint !== fingerprint) throw new ModelError('route_changed');
  return {connectionID:c.id,modelEntryID:m.entryID,fingerprint,configurationRevision:config.revision,connectionRevision:c.revision,apiProtocol:c.apiProtocol,baseURL,authMode:c.authMode,...(c.credentialRef ? {credentialRef:c.credentialRef} : {}),modelID:m.modelID,compatibility,tools:m.capabilities.tools.status,purpose,tokenBudget:Math.min(purpose==='text-chat'?2048:160,m.maxOutputTokens ?? 2048),timeoutMs:purpose==='text-chat'?60_000:25_000};
}
