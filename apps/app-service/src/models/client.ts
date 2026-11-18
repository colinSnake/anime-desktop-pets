import { ModelError } from './errors.ts';
import { resolveRoute, validateConfiguration } from './config.ts';
import { snapshotInput } from './common.ts';
import { adapters } from './protocols.ts';
import type { DiscoveryResult, ModelConfiguration, ModelInput, ModelPurpose, ModelReply, ModelRoute, ModelSelection } from './types.ts';

type Options = {
  readConfiguration: () => ModelConfiguration;
  /** Must resolve this immutable credential version, not a mutable connection-name alias. */
  readCredential: (ref: string, signal: AbortSignal) => Promise<string | undefined>;
  fetch?: typeof fetch;
  /** Internal tests/hosts may shorten deadlines, never extend the purpose's bound. */
  timeoutMs?: number;
};
const RESPONSE_BYTES = 1_048_576, DISCOVERY_BYTES = 4 * RESPONSE_BYTES, REQUEST_BYTES = 131_072;
const check = (signal: AbortSignal) => { if (signal.aborted) throw signal.reason instanceof ModelError ? signal.reason : new ModelError('cancelled'); };
const cancelBody = (response: Response) => { void response.body?.cancel().catch(() => {}); };
/** Service-internal, dependency-injected transport. No renderer routes or credential persistence. */
export class ModelClient {
  private closed = false;
  private readonly active = new Set<AbortController>();
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
  async discover(connectionID: string, signal?: AbortSignal): Promise<DiscoveryResult> {
    this.assertOpen();
    const config = validateConfiguration(this.configuration()), connection = config.connections.find(c => c.id === connectionID);
    if (!connection) throw new ModelError('route_changed');
    const route = resolveRoute({ ...config, defaultConnectionID: connectionID }, undefined, 'text-chat'), adapter = adapters[route.apiProtocol];
    return this.run(route, signal, async owned => {
      const auth = await this.auth(route, owned), seen = new Set<string>(), models = new Map<string, DiscoveryResult['models'][number]>(), budget = { bytes: 0, max: DISCOVERY_BYTES };
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        check(owned);
        const encoded = adapter.discovery(cursor), raw = await this.request(route, encoded.path, { method: 'GET', headers: { ...encoded.headers, ...auth } }, owned, budget);
        check(owned);
        const decoded = adapter.decodeDiscovery(raw);
        for (const model of decoded.models) {
          if (models.has(model.modelID)) continue;
          if (models.size === 256) return { models: [...models.values()], truncated: true };
          models.set(model.modelID, model);
        }
        if (decoded.truncated) return { models: [...models.values()], truncated: true };
        if (!decoded.next) return { models: [...models.values()], truncated: false };
        if (seen.has(decoded.next) || models.size === 256) return { models: [...models.values()], truncated: true };
        seen.add(decoded.next); cursor = decoded.next;
      }
      return { models: [...models.values()], truncated: true };
    });
  }
  close(): void {
    this.closed = true;
    for (const owned of this.active) owned.abort(new ModelError('closed'));
  }
  private assertOpen(): void { if (this.closed) throw new ModelError('closed'); }
  private configuration(): ModelConfiguration {
    try { return this.options.readConfiguration(); } catch { throw new ModelError('invalid_configuration'); }
  }
  private async run<T>(route: ModelRoute, external: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    if (external?.aborted) throw new ModelError('cancelled');
    if (this.active.size >= 3) throw new ModelError('busy');
    const controller = new AbortController(), owned = controller.signal;
    const cancel = () => controller.abort(new ModelError('cancelled'));
    external?.addEventListener('abort', cancel, { once: true });
    this.active.add(controller);
    const timeout = setTimeout(() => controller.abort(new ModelError('timed_out')), Math.min(route.timeoutMs, this.options.timeoutMs ?? route.timeoutMs));
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
    if (route.authMode === 'none') return {};
    if (!route.credentialRef) throw new ModelError('credentials_unavailable');
    let key: string | undefined;
    try { key = await this.options.readCredential(route.credentialRef!, signal); }
    catch { check(signal); throw new ModelError('credentials_unavailable'); }
    check(signal);
    if (typeof key !== 'string' || !key.trim() || key.length > 8192 || /[^\x21-\x7e]/.test(key)) throw new ModelError('credentials_unavailable');
    return route.apiProtocol === 'anthropic' ? { 'x-api-key': key } : route.apiProtocol === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` };
  }
  private async request(route: ModelRoute, path: string, init: RequestInit, signal: AbortSignal, budget: { bytes: number; max: number }): Promise<unknown> {
    check(signal);
    // Only adapter-owned relative paths; never follow an upstream-supplied URL.
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n\\#]/.test(path)) throw new ModelError('invalid_request');
    let response: Response;
    try { response = await this.transport(`${route.baseURL}${path}`, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
    catch { check(signal); throw new ModelError('upstream_unavailable'); }
    if (signal.aborted) { cancelBody(response); check(signal); }
    if (response.redirected || !response.ok) {
      cancelBody(response);
      throw new ModelError(response.status === 401 || response.status === 403 ? 'authentication_failed' : response.status === 429 ? 'rate_limited' : 'upstream_unavailable');
    }
    const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!type || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/.test(type) || !response.body) { cancelBody(response); throw new ModelError('invalid_response'); }
    const length = Number(response.headers.get('content-length'));
    if (length > RESPONSE_BYTES || length + budget.bytes > budget.max) { cancelBody(response); throw new ModelError('response_too_large'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
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
        chunks.push(part.value);
      }
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
      catch { throw new ModelError('invalid_response'); }
    } catch (error) {
      cancel(); check(signal);
      if (error instanceof ModelError) throw error;
      throw new ModelError('upstream_unavailable');
    } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  }
}
