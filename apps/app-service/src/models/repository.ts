import type { ModelConfiguration, ModelConnection } from './types.ts';
import { ModelClient } from './client.ts';
import { ModelError, type ModelErrorCode } from './errors.ts';
import { validateBaseURL, validateConfiguration } from './config.ts';
import { CredentialPreparationUncertain, type CredentialVault, type PreparedCredential } from './credentials.ts';
import type { ModelConfigurationStore, OnlineAuthority, Publication } from './configuration-store.ts';
export type ConnectionDraft = Omit<ModelConnection, 'revision' | 'credentialRef'>;
export type CredentialChange = { kind: 'keep' } | { kind: 'remove' } | { kind: 'replace'; key: string };
export type ModelMutation = Publication & { retainedCredentialVersions: boolean };
/** Failure state is independent of credential cleanup; contains no secret/cause. */
export class ModelMutationError extends ModelError {
  constructor(code: ModelErrorCode, readonly credentialCleanup: 'not_needed' | 'removed' | 'pending' | 'retained_uncertain') { super(code); }
}
function conflict(): never { throw new ModelError('configuration_conflict'); }
function invalid(): never { throw new ModelError('invalid_configuration'); }
const validRevision = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) < Number.MAX_SAFE_INTEGER;
const identifier = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s);
function editable(state: ModelConfiguration, id: string, expected: number): ModelConnection | undefined {
  const current = state.connections.find(c => c.id === id);
  if (!validRevision(expected) || (current ? current.revision !== expected : expected !== 0)) conflict();
  return current;
}
function update(state: ModelConfiguration, connection: ModelConnection): ModelConfiguration {
  const index = state.connections.findIndex(c => c.id === connection.id);
  if (index < 0) state.connections.push(connection); else state.connections[index] = connection;
  return validateConfiguration(state);
}
/** Own one repository/client authority per isolated profile. Never reads the old host configuration. */
export class ModelRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private client?: ModelClient;
  private authority?: OnlineAuthority;
  private closing?: Promise<void>;
  private constructor(private readonly store: ModelConfigurationStore, private readonly vault: CredentialVault, private state: ModelConfiguration) {}
  static async open(store: ModelConfigurationStore, vault: CredentialVault): Promise<ModelRepository> { return new ModelRepository(store, vault, await store.read()); }
  snapshot(): ModelConfiguration { this.assertOpen(); return structuredClone(this.state); }
  private assertOpen(): void { if (this.closed) throw new ModelError('closed'); }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(() => { this.assertOpen(); return operation(); }).catch(e => {
      if (e instanceof ModelError && e.code === 'publication_uncertain') this.failClosed();
      throw e;
    });
    this.queue = pending.catch(() => {}); return pending;
  }
  withSnapshot<T>(operation: (state: ModelConfiguration) => Promise<T>): Promise<T> {
    return this.enqueue(() => operation(this.snapshot()));
  }
  private failClosed = (): void => { this.closed = true; this.client?.close(); };
  private adopt(publication: Publication, retainedCredentialVersions = false): ModelMutation {
    const next = publication.configuration;
    for (const connection of this.state.connections) if (!next.connections.some(c => c.id === connection.id)) this.client?.revokeConnection(connection.id);
    this.state = structuredClone(next);
    return { ...publication, retainedCredentialVersions };
  }
  async saveConnection(draft: ConnectionDraft, expected: number, credential: CredentialChange = { kind: 'keep' }): Promise<ModelMutation> {
    // Snapshot untrusted mutable input before any async work, reject unknown
    // fields including caller-supplied credentialRef/revision. Only this layer
    // can retain or assign a credential version to a connection.
    let copy: ConnectionDraft, change: CredentialChange;
    try {
      copy = structuredClone(draft); change = structuredClone(credential);
      if (!copy || typeof copy !== 'object' || Array.isArray(copy) || !identifier(copy.id) || Object.keys(copy).some(k => !['id','displayName','preset','apiProtocol','baseURL','authMode','models','defaultModelEntryID','compatibility'].includes(k))) invalid();
      if (!change || typeof change !== 'object' || Array.isArray(change) || !['keep','remove','replace'].includes(change.kind) || Object.keys(change).some(k => k !== 'kind' && (change.kind !== 'replace' || k !== 'key'))) invalid();
    } catch { return Promise.reject(new ModelError('invalid_configuration')); }
    return this.enqueue(async () => {
      let prepared: PreparedCredential | undefined;
      try {
        const currentState = await this.store.read(), current = editable(currentState, copy.id, expected);
        const kept = change.kind === 'keep' ? current?.credentialRef : undefined;
        if (kept && current && (current.apiProtocol !== copy.apiProtocol ||
            validateBaseURL(current.baseURL, current.apiProtocol) !== validateBaseURL(copy.baseURL, copy.apiProtocol))) invalid();
        const connection: ModelConnection = { ...copy, revision: expected + 1, ...(kept ? { credentialRef: kept } : {}) };
        if (copy.authMode !== 'apiKey' && (change.kind === 'replace' || kept)) invalid();
        update(structuredClone(currentState), connection); // full validation before asking the secure backend
        if (change.kind === 'replace') prepared = await this.vault.prepare(copy.id, change.key);
        this.assertOpen();
        const result = await this.store.commit(undefined, state => {
          this.assertOpen(); editable(state, copy.id, expected);
          return update(state, { ...connection, revision: state.revision + 1, ...(prepared ? { credentialRef: prepared.ref } : {}) });
        }, { authority: this.authority, onUncertain: this.failClosed, onPublished: configuration => {
          if (prepared) this.vault.publish(prepared);
          this.adopt({ configuration, durability: 'unconfirmed' });
        } });
        return this.adopt(result, !!current?.credentialRef && current.credentialRef !== result.configuration.connections.find(c => c.id === copy.id)?.credentialRef);
      } catch (e) {
        if (e instanceof ModelError && e.code === 'publication_uncertain') {
          if (prepared) this.vault.publish(prepared);
          this.failClosed();
          throw new ModelMutationError(e.code, prepared ? 'retained_uncertain' : 'not_needed');
        }
        if (e instanceof CredentialPreparationUncertain) throw new ModelMutationError(e.code, 'retained_uncertain');
        const cleanup = prepared ? await this.vault.discard(prepared) ? 'removed' : 'pending' : 'not_needed';
        throw new ModelMutationError(e instanceof ModelError ? e.code : 'storage_unavailable', cleanup);
      }
    });
  }
  removeConnection(id: string, expected: number, replacement: string | null | undefined): Promise<ModelMutation> {
    if (!identifier(id) || (replacement !== undefined && replacement !== null && !identifier(replacement))) return Promise.reject(new ModelError('invalid_configuration'));
    return this.enqueue(async () => {
      let retained = false;
      const result = await this.store.commit(undefined, state => {
        this.assertOpen(); const current = editable(state, id, expected); if (!current) conflict(); retained = !!current.credentialRef;
        if (state.defaultConnectionID === id) {
          if (replacement === undefined || replacement === id || (replacement !== null && !state.connections.some(c => c.id === replacement))) invalid();
          state.defaultConnectionID = replacement;
        } else if (replacement !== undefined) invalid();
        state.connections = state.connections.filter(c => c.id !== id);
        return validateConfiguration(state);
      }, { authority: this.authority, onUncertain: this.failClosed, onPublished: configuration => {
        this.client?.revokeConnection(id); this.adopt({ configuration, durability: 'unconfirmed' });
      } });
      // Explicit removal is a revocation even if an external writer had already
      // made the snapshot differ. It cannot cancel requests for other services.
      this.client?.revokeConnection(id); return this.adopt(result, retained);
    });
  }
  setDefault(expected: number, connectionID: string | null, entryID?: string): Promise<ModelMutation> {
    if (connectionID === null ? entryID !== undefined : !identifier(connectionID) || !identifier(entryID)) return Promise.reject(new ModelError('invalid_configuration'));
    return this.enqueue(async () => this.adopt(await this.store.commit(expected, state => {
      this.assertOpen();
      if (connectionID === null) { state.defaultConnectionID = null; return validateConfiguration(state); }
      const connection = state.connections.find(c => c.id === connectionID);
      if (!connection || !connection.models.some(m => m.entryID === entryID)) invalid();
      if (connection.defaultModelEntryID !== entryID) {
        if (!validRevision(connection.revision)) conflict();
        connection.revision = state.revision + 1; connection.defaultModelEntryID = entryID!;
      }
      state.defaultConnectionID = connectionID; return validateConfiguration(state);
    }, { authority: this.authority, onUncertain: this.failClosed, onPublished: configuration => { this.adopt({ configuration, durability: 'unconfirmed' }); } })));
  }
  createClient({ fetch: transport }: { fetch?: typeof fetch } = {}): Promise<ModelClient> {
    return this.enqueue(async () => {
      if (this.client) throw new ModelError('busy');
      const { configuration, authority } = await this.store.acquireOnlineAuthority(); this.authority = authority;
      this.assertOpen(); this.adopt({ configuration, durability: 'unconfirmed' });
      this.client = new ModelClient({ readConfiguration: () => this.snapshot(), readCredential: (ref, signal, connectionID) => this.vault.read(ref, signal, connectionID), fetch: transport });
      return this.client;
    });
  }
  close(): Promise<void> {
    this.failClosed();
    if (this.closing) return this.closing;
    const operation = this.queue.then(async () => {
      if (this.authority) {
        await this.store.releaseOnlineAuthority(this.authority);
        this.authority = undefined;
      }
    });
    this.closing = operation;
    void operation.catch(() => { if (this.closing === operation) this.closing = undefined; });
    return operation;
  }
}
