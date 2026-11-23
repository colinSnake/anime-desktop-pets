import { streamingModelProbeTimeoutMs, type ModelProbeInput } from '../../../../packages/contracts/src/model-probe.ts';
import type { ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { resolveChatRoute } from './chat-models.ts';
import { validDiscoveryCandidate, type ModelCandidate } from '../../../../packages/contracts/src/models.ts';
import { ModelError, type ModelErrorCode } from './errors.ts';
import { resolveRoute, routeFor, validateConfiguration } from './config.ts';
import { array, object, snapshotInput } from './common.ts';
import { adapters } from './protocols.ts';
import type { DiscoveryResult, ModelConfiguration, ModelInput, ModelPurpose, ModelReply, ModelRoute, ModelSelection } from './types.ts';

/** Invoke dispatch synchronously under the authorization queue, then release the queue. */
export type FreshChatInput = (dispatch: (input: ModelInput) => void, signal: AbortSignal) => Promise<void>;
type Options = {
  readConfiguration: () => ModelConfiguration;
  /** Must resolve this immutable credential version, not a mutable connection-name alias. */
  readCredential: (ref: string, signal: AbortSignal, connectionID: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  /** Internal tests/hosts may shorten deadlines, never extend the purpose's bound. */
  timeoutMs?: number;
};
const RESPONSE_BYTES = 1_048_576, DISCOVERY_BYTES = 4 * RESPONSE_BYTES, REQUEST_BYTES = 131_072, ATTACHMENT_REQUEST_BYTES = 24 * 1024 * 1024;
const check = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason instanceof ModelError ? signal.reason : new ModelError('cancelled'); };
const cancelBody = (response: Response) => { void response.body?.cancel().catch(() => {}); };

type ProbeMode = 'json' | 'streaming-responses';
const probeHttpErrors: Readonly<Partial<Record<number, ModelErrorCode>>> = {
  400: 'provider_bad_request', 401: 'authentication_failed', 403: 'provider_forbidden',
  404: 'provider_not_found', 422: 'provider_bad_request', 429: 'rate_limited',
};
const probeMarker = 'OK';
function verifyResponsesProbe(raw: unknown, requireMarker: boolean): void {
  const response = object(raw);
  if (response.error != null) throw new ModelError('invalid_response');
  if (response.status === 'incomplete' && response.incomplete_details != null && object(response.incomplete_details).reason === 'max_output_tokens') {
    throw new ModelError('output_budget_exhausted');
  }
  if (response.status !== 'completed' || response.incomplete_details != null) throw new ModelError('invalid_response');
  if (!requireMarker) return;
  // Reasoning is not evidence of a successful probe; neither are tool calls or partial text.
  const messages = array(response.output).map(object).filter(item => item.type !== 'reasoning');
  if (messages.length !== 1) throw new ModelError('invalid_response');
  const message = messages[0]!;
  if (message.type !== 'message' || message.role !== 'assistant' || (message.status != null && message.status !== 'completed')) throw new ModelError('invalid_response');
  const content = array(message.content);
  if (content.length !== 1) throw new ModelError('invalid_response');
  const part = object(content[0]);
  if (part.type !== 'output_text' || typeof part.text !== 'string' || part.text.trim() !== probeMarker) throw new ModelError('invalid_response');
}

/** Consume only framed SSE events and stop at the first valid terminal envelope. */
function createResponsesStreamParser() {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', event = '', data: string[] = [], skipLeadingLf = false;
  const dispatch = () => {
    const payload = data.join('\n'), name = event;
    event = ''; data = [];
    if (!payload) return;
    let message: Record<string, unknown>;
    try { message = object(JSON.parse(payload)); } catch { throw new ModelError('invalid_response'); }
    const { type } = message;
    if (typeof type !== 'string' || (name && name !== 'message' && name !== type)) throw new ModelError('invalid_response');
    if (type === 'response.failed' || type === 'error') throw new ModelError('invalid_response');
    if (type !== 'response.completed' && type !== 'response.incomplete') return;
    const response = object(message.response);
    if (type !== `response.${response.status}`) throw new ModelError('invalid_response');
    return response;
  };
  return (chunk: Uint8Array) => {
    let text: string;
    try { text = decoder.decode(chunk, { stream: true }); } catch { throw new ModelError('invalid_response'); }
    if (!text) return;
    if (skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
    skipLeadingLf = text.endsWith('\r');
    let start = 0;
    for (const newline of text.matchAll(/\r\n?|\n/g)) {
      const field = line + text.slice(start, newline.index);
      line = '';
      start = newline.index + newline[0].length;
      if (!field) {
        const terminal = dispatch();
        if (terminal) return terminal;
      } else if (field.startsWith('data:')) data.push(field.slice(5).replace(/^ /, ''));
      else if (field === 'data') data.push('');
      else if (field.startsWith('event:')) event = field.slice(6).replace(/^ /, '');
      else if (field === 'event') event = '';
    }
    line += text.slice(start);
  };
}
/** Service-internal, dependency-injected transport. No renderer routes or credential persistence. */
export class ModelClient {
  private closed = false;
  private readonly active = new Map<AbortController, string>();
  private readonly transport: typeof fetch;
  constructor(private readonly options: Options) {
    this.transport = options.fetch ?? globalThis.fetch;
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60_000)) throw new ModelError('invalid_configuration');
  }
  async complete(selection: ModelSelection | undefined, purpose: ModelPurpose, input: ModelInput, signal?: AbortSignal): Promise<ModelReply> {
    this.assertOpen();
    // Everything mutable is resolved before the first await, including replay associations.
    const route = resolveRoute(this.configuration(), selection, purpose), snapshot = snapshotInput(route, input);
    const encoded = adapters[route.apiProtocol].encode(route, snapshot), body = JSON.stringify(encoded.body);
    if (Buffer.byteLength(body) > REQUEST_BYTES) throw new ModelError('invalid_request');
    return this.run(route, signal, async owned => {
      const auth = await this.auth(route, owned);
      const result = await this.request(route, encoded.path, { method: 'POST', headers: { ...encoded.headers, ...auth, 'content-type': 'application/json' }, body }, owned, { bytes: 0, max: RESPONSE_BYTES });
      check(owned);
      const decoded = adapters[route.apiProtocol].decode(route, result), names = new Set(snapshot.tools?.map(t => t.name));
      if (decoded.message.toolCalls?.some(c => !names.has(c.name))) throw new ModelError('invalid_response');
      return decoded;
    });
  }
  completeChat(selection: ChatRoute, prepare: FreshChatInput, signal: AbortSignal): Promise<ModelReply> {
    return this.completePinned(selection, prepare, signal);
  }
  completeTask(selection: ChatRoute, revision: number, prepare: FreshChatInput, signal: AbortSignal): Promise<ModelReply> {
    return this.completePinned(selection, prepare, signal, revision);
  }
  private async completePinned(selection: ChatRoute, prepare: FreshChatInput, signal: AbortSignal, taskRevision?: number): Promise<ModelReply> {
    this.assertOpen();
    const resolve = () => {
      const current = resolveChatRoute(this.configuration(), selection);
      if (taskRevision === undefined) return current;
      if (current.connectionRevision !== taskRevision) throw new ModelError('route_changed');
      if (current.tools === 'unsupported') throw new ModelError('tools_unavailable');
      return { ...current, purpose: 'agent-task' as const };
    };
    const route = resolve();
    return this.run(route, signal, async owned => {
      const auth = await this.auth(route, owned);
      const key = auth.authorization?.slice(7) ?? auth['x-api-key'] ?? auth['x-goog-api-key'];
      const sensitive = [key, route.credentialRef].filter((value): value is string => !!value);
      const containsSensitive = (text: string) => sensitive.some(value => text.includes(value));
      let pending: Promise<unknown> | undefined;
      let toolNames: string[] = [];
      await prepare(input => {
        check(owned);
        if (pending) throw new ModelError('invalid_request');
        const current = resolve();
        const snapshot = snapshotInput(current, input);
        if (taskRevision === undefined && snapshot.tools?.length) throw new ModelError('invalid_request');
        toolNames = snapshot.tools?.map(tool => tool.name) ?? [];
        if (snapshot.messages.some(message => containsSensitive(message.text)) || snapshot.referenceData &&
            sensitive.some(value => JSON.stringify(snapshot.referenceData).includes(JSON.stringify(value).slice(1, -1)))) throw new ModelError('invalid_request');
        const encoded = adapters[route.apiProtocol].encode(current, snapshot), body = JSON.stringify(encoded.body);
        const maxRequestBytes = snapshot.messages.some(message => message.role === 'user' && message.attachments?.length)
          ? ATTACHMENT_REQUEST_BYTES : REQUEST_BYTES;
        if (Buffer.byteLength(body) > maxRequestBytes || sensitive.some(value => body.includes(JSON.stringify(value).slice(1, -1)))) throw new ModelError('invalid_request');
        // request() invokes the injected fetch synchronously before its first await.
        pending = this.request(current, encoded.path, { method: 'POST', headers: { ...encoded.headers, ...auth, 'content-type': 'application/json' }, body }, owned, { bytes: 0, max: RESPONSE_BYTES });
        void pending.catch(() => {});
      }, owned);
      if (!pending) throw new ModelError('invalid_request');
      const raw = await pending;
      check(owned);
      resolve();
      const result = adapters[route.apiProtocol].decode(route, raw);
      const names = new Set(toolNames);
      if (result.message.toolCalls?.some(call => taskRevision === undefined || !names.has(call.name)) ||
          containsSensitive(result.message.text) || sensitive.some(value => JSON.stringify(result.message).includes(JSON.stringify(value).slice(1, -1)))) throw new ModelError('invalid_response');
      return result;
    });
  }
  async testConnection(input: ModelProbeInput, signal: AbortSignal): Promise<void> {
    this.assertOpen();
    const { connectionID, expectedRevision, entryID, modelID, maxOutputTokens, outputTokenField } = input;
    const current = () => {
      const state = this.configuration(), connection = state.connections.find(item => item.id === connectionID);
      if (!connection || connection.revision !== expectedRevision) throw new ModelError('configuration_conflict');
      return { state, connection };
    };
    const { state, connection } = current();
    if (outputTokenField && connection.apiProtocol !== 'chat-completions') throw new ModelError('invalid_configuration');
    const compatibility = outputTokenField ? { outputTokenField } : {};
    const route = routeFor(state.revision, { ...connection, compatibility }, { entryID, modelID, displayName: modelID, maxOutputTokens,
      capabilities: { tools: { status: 'unsupported', source: 'user' } }, compatibility }, 'text-chat');
    // Gate streaming on the saved protocol and origin, not a renderer-supplied flag.
    const streamResponses = route.apiProtocol === 'responses' && new URL(route.baseURL).origin !== 'https://api.deepseek.com';
    route.tokenBudget = Math.min(streamResponses ? 256 : 32, route.tokenBudget);
    const adapter = adapters[route.apiProtocol];
    const encoded = adapter.encode(route, { messages: [{ role: 'user', text: streamResponses ? `Reply with exactly ${probeMarker}. Do not use tools.` : 'Reply with OK.' }] });
    const body = JSON.stringify(streamResponses
      ? { model: route.modelID, input: encoded.body.input, store: false, stream: true, max_output_tokens: route.tokenBudget }
      : route.apiProtocol === 'responses' ? { ...encoded.body, stream: false } : encoded.body);
    return this.run(route, signal, async owned => {
      const auth = await this.auth(route, owned);
      const key = auth.authorization?.slice(7) ?? auth['x-api-key'] ?? auth['x-goog-api-key'];
      if (key && modelID.includes(key) || route.credentialRef && modelID.includes(route.credentialRef)) throw new ModelError('invalid_configuration');
      current();
      const raw = await this.request(route, encoded.path, { method: 'POST', headers: { ...encoded.headers, ...auth, ...(streamResponses ? { accept: 'text/event-stream, application/json' } : {}), 'content-type': 'application/json' }, body }, owned, { bytes: 0, max: 64 * 1024 }, streamResponses ? 'streaming-responses' : 'json');
      check(owned); current();
      if (route.apiProtocol === 'responses') verifyResponsesProbe(raw, streamResponses);
      if (streamResponses) return; // The probe verified the marker without retaining private reasoning or replay.
      const result = adapter.decode(route, raw);
      if (result.stop === 'refused' || result.stop === 'tools' || result.message.toolCalls?.length || !result.message.text.trim()) throw new ModelError('invalid_response');
    }, streamResponses ? streamingModelProbeTimeoutMs : 15_000);
  }
  async discover(connectionID: string, signal?: AbortSignal): Promise<DiscoveryResult> {
    return this.discoverModels(connectionID, signal);
  }
  async discoverFirstPage(connectionID: string, signal: AbortSignal): Promise<{ candidates: ModelCandidate[]; truncated: boolean }> {
    const result = await this.discoverModels(connectionID, signal, true);
    return { candidates: result.models.map(({ modelID, displayName }) => ({ modelID, displayName })), truncated: result.truncated };
  }
  private async discoverModels(connectionID: string, signal?: AbortSignal, firstPage = false): Promise<DiscoveryResult> {
    this.assertOpen();
    const config = validateConfiguration(this.configuration()), connection = config.connections.find(c => c.id === connectionID);
    if (!connection) throw new ModelError('route_changed');
    const route = resolveRoute({ ...config, defaultConnectionID: connectionID }, undefined, 'text-chat'), adapter = adapters[route.apiProtocol];
    return this.run(route, signal, async owned => {
      const auth = await this.auth(route, owned), seen = new Set<string>(), models = new Map<string, DiscoveryResult['models'][number]>(), budget = { bytes: 0, max: DISCOVERY_BYTES };
      const sensitive = firstPage ? [route.credentialRef, auth.authorization?.slice(7) ?? auth['x-api-key'] ?? auth['x-goog-api-key']].filter((v): v is string => !!v) : [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        check(owned);
        const encoded = adapter.discovery(cursor), raw = await this.request(route, encoded.path, { method: 'GET', headers: { ...encoded.headers, ...auth } }, owned, budget);
        check(owned);
        const decoded = adapter.decodeDiscovery(raw, firstPage);
        for (let model of decoded.models) {
          if (firstPage) {
            if (sensitive.some(value => model.modelID.includes(value) || model.displayName.includes(value))) throw new ModelError('invalid_response');
            let displayName = model.displayName.trim();
            if (Buffer.byteLength(displayName) > 128) {
              let bounded = '', bytes = 0;
              for (const character of displayName) {
                bytes += Buffer.byteLength(character);
                if (bytes > 128) break;
                bounded += character;
              }
              displayName = bounded.trimEnd();
            }
            if (!validDiscoveryCandidate({ modelID: model.modelID, displayName })) throw new ModelError('invalid_response');
            model = { ...model, displayName };
          }
          if (models.has(model.modelID)) continue;
          if (models.size === 256) return { models: [...models.values()], truncated: true };
          models.set(model.modelID, model);
        }
        if (decoded.truncated) return { models: [...models.values()], truncated: true };
        if (!decoded.next) return { models: [...models.values()], truncated: false };
        if (firstPage || seen.has(decoded.next) || models.size === 256) return { models: [...models.values()], truncated: true };
        seen.add(decoded.next); cursor = decoded.next;
      }
      return { models: [...models.values()], truncated: true };
    }, firstPage ? 15_000 : undefined);
  }
  /** Explicit saved-connection revocation; ordinary edits keep their snapshot. */
  revokeConnection(connectionID: string): void {
    for (const [owned, id] of this.active) if (id === connectionID) owned.abort(new ModelError('route_changed'));
  }
  close(): void {
    this.closed = true;
    for (const owned of this.active.keys()) owned.abort(new ModelError('closed'));
  }
  private assertOpen(): void { if (this.closed) throw new ModelError('closed'); }
  private configuration(): ModelConfiguration {
    try { return this.options.readConfiguration(); } catch { throw new ModelError('invalid_configuration'); }
  }
  private async run<T>(route: ModelRoute, external: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>, deadline = route.timeoutMs): Promise<T> {
    this.assertOpen();
    if (external?.aborted) throw new ModelError('cancelled');
    if (this.active.size >= 3) throw new ModelError('busy');
    const controller = new AbortController(), owned = controller.signal;
    const cancel = () => controller.abort(new ModelError('cancelled'));
    external?.addEventListener('abort', cancel, { once: true });
    this.active.set(controller, route.connectionID);
    const timeout = setTimeout(() => controller.abort(new ModelError('timed_out')), Math.min(deadline, this.options.timeoutMs ?? deadline));
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(owned.reason); owned.addEventListener('abort', onAbort, { once: true }); });
    try {
      const value = await Promise.race([action(owned), aborted]); check(owned); return value;
    } catch (error) {
      check(owned);
      if (error instanceof ModelError) throw error;
      throw new ModelError('upstream_unavailable');
    } finally {
      clearTimeout(timeout); external?.removeEventListener('abort', cancel); owned.removeEventListener('abort', onAbort); this.active.delete(controller);
    }
  }
  private async auth(route: ModelRoute, signal: AbortSignal): Promise<Record<string, string>> {
    check(signal);
    if (!route.credentialRef) return {}; // Optional authentication; the upstream decides whether to accept it.
    let key: string | undefined;
    try { key = await this.options.readCredential(route.credentialRef, signal, route.connectionID); }
    catch (error) { check(signal); throw new ModelError(error instanceof ModelError && error.code === 'busy' ? 'busy' : 'credentials_unavailable'); }
    check(signal);
    if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[^\x21-\x7e]/.test(key)) throw new ModelError('credentials_unavailable');
    return route.apiProtocol === 'anthropic' ? { 'x-api-key': key } : route.apiProtocol === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
  }
  private async request(route: ModelRoute, path: string, init: RequestInit, signal: AbortSignal, budget: { bytes: number; max: number }, probe?: ProbeMode): Promise<unknown> {
    check(signal);
    // Only adapter-owned relative paths; never follow an upstream-supplied URL.
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\#]/.test(path)) throw new ModelError('invalid_request');
    let response: Response;
    try { response = await this.transport(`${route.baseURL}${path}`, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
    catch { check(signal); throw new ModelError('upstream_unavailable'); }
    if (signal.aborted) { cancelBody(response); check(signal); }
    if (response.redirected || !response.ok) {
      cancelBody(response);
      if (probe && !response.redirected) throw new ModelError(probeHttpErrors[response.status] ?? 'upstream_unavailable');
      throw new ModelError(response.status === 401 || response.status === 403 ? 'authentication_failed' : response.status === 429 ? 'rate_limited' : 'upstream_unavailable');
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const eventStream = probe === 'streaming-responses' && type === 'text/event-stream';
    if (!type || (!eventStream && !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(type)) || !response.body) { cancelBody(response); throw new ModelError('invalid_response'); }
    const length = Number(response.headers.get('content-length'));
    if (length > RESPONSE_BYTES || length + budget.bytes > budget.max) { cancelBody(response); throw new ModelError('response_too_large'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [], streamParser = eventStream ? createResponsesStreamParser() : undefined;
    let bytes = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        check(signal);
        const part = await reader.read(); check(signal);
        if (part.done) break;
        bytes += part.value.byteLength; budget.bytes += part.value.byteLength;
        if (bytes > RESPONSE_BYTES || budget.bytes > budget.max) throw new ModelError('response_too_large');
        if (streamParser) {
          const terminal = streamParser(part.value);
          if (terminal) { cancel(); return terminal; }
        } else chunks.push(part.value);
      }
      if (streamParser) throw new ModelError('invalid_response');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { throw new ModelError('invalid_response'); }
    } catch (error) {
      cancel(); check(signal);
      if (error instanceof ModelError) throw error;
      throw new ModelError('upstream_unavailable');
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  }
}
