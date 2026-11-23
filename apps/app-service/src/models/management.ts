import { modelProbeStatus, probeError, validProbeInput, type ModelProbeError, type ModelProbeReply } from '../../../../packages/contracts/src/model-probe.ts';
import { MODEL_DISCOVERY_ERRORS, validDiscoveryInput, type ModelDiscoveryReply } from '../../../../packages/contracts/src/models.ts';
import { discoveryError } from './discovery-contract.ts';
import type { ModelClient, FreshChatInput } from './client.ts';
import type { ChatRoute } from '../../../../packages/contracts/src/online-chat.ts';
import { chatOptions, resolveChatRoute } from './chat-models.ts';
import { ModelConfigurationStore, type PublicationIO } from './configuration-store.ts';
import { CredentialVault, type SecureCredentialBackend } from './credentials.ts';
import { ModelError } from './errors.ts';
import { managementError, validModelInput, type ModelAction, type ModelInputs, type ModelManagementReply, type SavedModelConfiguration } from './management-contract.ts';
import { ModelMutationError, ModelRepository } from './repository.ts';
import type { ModelConfiguration } from './types.ts';

const saved = (state: ModelConfiguration): SavedModelConfiguration => ({
  revision: state.revision, defaultConnectionID: state.defaultConnectionID,
  connections: state.connections.map(({ credentialRef, ...connection }) => ({
    ...connection, credentialState: connection.authMode === 'none' ? 'not-required' : credentialRef ? 'reference-present' : 'missing',
  })),
});

/** Configuration management and read-only discovery for the saved profile. */
export class ModelManagement {
  private repository?: Promise<ModelRepository>;
  private readonly store: ModelConfigurationStore;
  private readonly vault: CredentialVault;
  private writing = false;
  private closed = false;
  private writesBlocked = false;
  private client?: Promise<ModelClient>;
  private inspection?: { connectionID: string; controller: AbortController };
  constructor(root: string, backend: SecureCredentialBackend | undefined, publication?: PublicationIO, private readonly online?: { fetch?: typeof fetch }) {
    this.store = new ModelConfigurationStore(root, publication);
    this.vault = new CredentialVault(backend);
  }
  async run(method: ModelAction, input: unknown): Promise<ModelManagementReply> {
    if (this.closed) return managementError('unavailable');
    if (!validModelInput(method, input)) return managementError('invalid_configuration');
    const writing = method !== 'list';
    if (writing && this.writesBlocked) return managementError('publication_uncertain');
    if (writing && this.writing) return managementError('busy');
    if (writing) {
      this.writing = true; // Do not queue another request containing a Key.
      const id = method === 'save' ? (input as ModelInputs['save']).connection.id :
        method === 'remove' ? (input as ModelInputs['remove']).connectionID : (input as ModelInputs['default']).connectionID;
      if (this.inspection && this.inspection.connectionID === id) this.inspection.controller.abort();
    }
    try {
      if (method === 'list') {
        const configuration = await this.store.read();
        return this.closed ? managementError('unavailable') : { version: 1, ok: true, configuration: saved(configuration),
          ...(this.writesBlocked ? { writesBlocked: true } : {}) };
      }
      const repository = await this.openRepository();
      if (this.closed) return managementError('unavailable');
      const mutation = await (async () => {
        switch (method) {
          case 'save': { const { connection, expectedRevision, credential } = input as ModelInputs['save']; return repository.saveConnection(connection, expectedRevision, credential); }
          case 'default': { const value = input as ModelInputs['default']; return repository.setDefault(value.expectedRevision, value.connectionID, 'entryID' in value ? value.entryID : undefined); }
          case 'remove': { const { connectionID, expectedRevision, replacementDefault } = input as ModelInputs['remove']; return repository.removeConnection(connectionID, expectedRevision, replacementDefault); }
        }
      })();
      return { version: 1, ok: true, configuration: saved(mutation.configuration), durability: mutation.durability, retainedCredentialVersions: mutation.retainedCredentialVersions };
    } catch (error) {
      const code = error instanceof ModelError ? error.code : undefined;
      if (code === 'publication_uncertain') { this.writesBlocked = true; this.inspection?.controller.abort(); }
      const allowed = ['invalid_configuration', 'configuration_conflict', 'credentials_unavailable', 'storage_unavailable', 'publication_uncertain', 'busy'] as const;
      return managementError(allowed.find(candidate => candidate === code) ?? 'unavailable',
        error instanceof ModelMutationError ? error.credentialCleanup : undefined);
    } finally { if (writing) this.writing = false; }
  }
  private openRepository(): Promise<ModelRepository> {
    const opening = this.repository ??= ModelRepository.open(this.store, this.vault);
    return opening.catch(error => {
      if (this.repository === opening) this.repository = undefined;
      throw error;
    });
  }
  private async onlineClient(repository: ModelRepository): Promise<ModelClient> {
    const opening = this.client ??= repository.createClient(this.online);
    try { return await opening; }
    catch (error) { if (this.client === opening) this.client = undefined; throw error; }
  }
  async listChatModels() {
    if (this.closed || this.writesBlocked) throw new ModelError('closed');
    return chatOptions(await this.store.read());
  }
  async completeChat(route: ChatRoute, prepare: FreshChatInput, signal: AbortSignal) {
    if (this.closed || this.writesBlocked) throw new ModelError('closed');
    const repository = await this.openRepository();
    if (signal.aborted) throw new ModelError('cancelled');
    const client = await this.onlineClient(repository);
    return client.completeChat(route, prepare, signal);
  }
  async completeAgentTask(route: ChatRoute, revision: number, prepare: FreshChatInput, signal: AbortSignal) {
    if (this.closed || this.writesBlocked || signal.aborted) throw new ModelError(signal.aborted ? 'cancelled' : 'closed');
    const repository = await this.openRepository();
    if (signal.aborted) throw new ModelError('cancelled');
    return (await this.onlineClient(repository)).completeTask(route, revision, prepare, signal);
  }
  async assertChatRoute(route: ChatRoute) {
    if (this.closed || this.writesBlocked) throw new ModelError('closed');
    // Validate a restarted profile before launching the SDK, without taking a
    // writer lease or touching the credential vault. After dispatch, use the
    // currently owned snapshot when one exists.
    const state = this.repository ? (await this.repository).snapshot() : await this.store.read();
    if (this.closed || this.writesBlocked) throw new ModelError('closed');
    return resolveChatRoute(state, route);
  }
  async discover(input: unknown, signal?: AbortSignal): Promise<ModelDiscoveryReply> {
    if (!validDiscoveryInput(input)) return discoveryError('invalid_configuration');
    if (this.closed) return discoveryError('unavailable');
    if (this.writesBlocked) return discoveryError('publication_uncertain');
    if (this.writing || this.inspection) return discoveryError('busy');
    if (signal?.aborted) return discoveryError('cancelled');
    const { connectionID, expectedRevision } = input, controller = new AbortController();
    const cancel = () => controller.abort();
    this.inspection = { connectionID, controller };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const repository = await this.openRepository();
      if (controller.signal.aborted) return discoveryError('cancelled');
      const client = await this.onlineClient(repository);
      if (controller.signal.aborted) return discoveryError('cancelled');
      if (this.writing) return discoveryError('busy');
      const current = repository.snapshot().connections.find(c => c.id === connectionID);
      if (current?.revision !== expectedRevision) return discoveryError('configuration_conflict');
      const result = await client.discoverFirstPage(connectionID, controller.signal);
      if (controller.signal.aborted) return discoveryError('cancelled');
      return { version: 1, ok: true, connectionID, revision: expectedRevision, ...result };
    } catch (error) {
      if (controller.signal.aborted) return discoveryError('cancelled');
      const code = error instanceof ModelError ? error.code : undefined;
      return discoveryError(MODEL_DISCOVERY_ERRORS.find(candidate => candidate === code) ?? 'unavailable');
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.inspection = undefined;
    }
  }
  async testConnection(input: unknown, signal?: AbortSignal): Promise<ModelProbeReply> {
    if (!validProbeInput(input)) return probeError('invalid_configuration');
    if (this.closed) return probeError('unavailable');
    if (this.writesBlocked) return probeError('publication_uncertain');
    if (this.writing || this.inspection) return probeError('busy');
    if (signal?.aborted) return probeError('cancelled');
    const copy = structuredClone(input), { connectionID, expectedRevision, entryID } = copy;
    const controller = new AbortController(), cancel = () => controller.abort();
    this.inspection = { connectionID, controller };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const repository = await this.openRepository();
      if (controller.signal.aborted) return probeError('cancelled');
      const client = await this.onlineClient(repository);
      if (controller.signal.aborted) return probeError('cancelled');
      if (this.writing) return probeError('busy');
      await client.testConnection(copy, controller.signal);
      return controller.signal.aborted ? probeError('cancelled') : { version: 1, ok: true, connectionID, revision: expectedRevision, entryID };
    } catch (error) {
      if (controller.signal.aborted) return probeError('cancelled');
      const code = error instanceof ModelError ? error.code : undefined;
      return probeError(code && Object.hasOwn(modelProbeStatus, code) ? code as ModelProbeError : 'unavailable');
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.inspection = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.inspection?.controller.abort();
    const repository = await this.repository?.catch(() => undefined);
    await repository?.close();
  }
}
