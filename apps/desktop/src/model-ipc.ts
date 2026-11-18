import { isProbeReply, modelProbeBytes, modelProbeIPC, probeError, validProbeInput, type ModelProbeReply } from '../../../packages/contracts/src/model-probe.ts';
import { discoveryError } from '../../app-service/src/models/discovery-contract.ts';
import { validDiscoveryInput, validDiscoveryOperation, type ModelDiscoveryReply } from '../../../packages/contracts/src/models.ts';
import { MODEL_BODY_LIMIT, validModelInput } from '../../app-service/src/models/management-contract.ts';
import type { ModelDefault, ModelEdit, ModelRemove, ModelSave, ModelWorkspaceReply } from '../../../packages/contracts/src/models.ts';
import type { ServiceProcess } from './service-process.ts';

export const MODEL_IPC = {
  list: 'pet:models-list', save: 'pet:models-save', setDefault: 'pet:models-default', remove: 'pet:models-remove',
  prepareKeySave: 'pet:models-prepare-key-save', cancelKeySave: 'pet:models-cancel-key-save',
} as const;
export const MODEL_DISCOVERY_IPC = { discover: 'pet:models-discover', cancelDiscovery: 'pet:models-cancel-discovery' } as const;
type Method = keyof typeof MODEL_IPC;
type Failure = Extract<ModelWorkspaceReply, { ok: false }>['error'];
const failure = (error: Failure): ModelWorkspaceReply => ({ version: 1, ok: false, error });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export type ModelMenuIntent = { origin: string; submit(ownsFocus: boolean): void };
type Pending = { input: ModelEdit; finish(value: ModelWorkspaceReply): void; timer: ReturnType<typeof setTimeout> };

/** Only the native menu receives the one-use submit callback. IPC never reads the clipboard. */
export class ModelIPC {
  private pending?: Pending;
  private writing = false;
  private writesBlocked = false;
  private clipboardRead?: AbortController;
  private inspection?: { kind: 'discovery' | 'probe'; id: string; controller: AbortController };
  constructor(private readonly service: Pick<ServiceProcess, 'listModels' | 'saveModelConnection' | 'setModelDefault' | 'removeModelConnection'> & Partial<Pick<ServiceProcess, 'discoverModels' | 'testModelConnection'>>,
    private readonly native: { readClipboard(): string | Promise<string>; menuChanged(intent?: ModelMenuIntent): void; expiresMs?: number }) {}

  async invoke(method: Method, trusted: boolean, args: unknown[]): Promise<ModelWorkspaceReply> {
    if (!trusted) return failure('unavailable');
    if (method === 'list' || method === 'cancelKeySave') {
      if (args.length !== 0) return failure('invalid_configuration');
      if (method === 'cancelKeySave') { this.cancelKey(); return failure('key_input_cancelled'); }
      try {
        const result = await this.service.listModels();
        if (result.ok && result.writesBlocked) { this.writesBlocked = true; this.cancel(); }
        return result;
      } catch { return failure('unavailable'); }
    }
    if (args.length !== 1 || !record(args[0])) return failure('invalid_configuration');
    const input = args[0];
    if (this.writesBlocked) return failure('publication_uncertain');
    if (this.pending || this.writing) return failure('busy');
    if (method === 'prepareKeySave') {
      if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'connection') || !Object.hasOwn(input, 'expectedRevision') ||
          !record(input.connection) || input.connection.authMode !== 'apiKey' ||
          !validModelInput('save', { ...input, credential: { kind: 'keep' } }) ||
          !this.fits({ ...input, credential: { kind: 'replace', key: '"'.repeat(8192) } })) return failure('invalid_configuration');
      return this.prepare(structuredClone(input) as ModelEdit);
    }
    if (method === 'save' && record(input.credential) && (input.credential.kind === 'keep' || input.credential.kind === 'remove') &&
        validModelInput('save', input) && this.fits(input)) return this.write(() => this.service.saveModelConnection(input as ModelSave));
    if (method === 'setDefault' && validModelInput('default', input)) return this.write(() => this.service.setModelDefault(input as ModelDefault));
    if (method === 'remove' && validModelInput('remove', input)) return this.write(() => this.service.removeModelConnection(input as ModelRemove));
    return failure('invalid_configuration');
  }

  async invokeDiscovery(method: keyof typeof MODEL_DISCOVERY_IPC, trusted: boolean, args: unknown[]): Promise<ModelDiscoveryReply> {
    if (!trusted) return discoveryError('unavailable');
    if (args.length !== 1) return discoveryError('invalid_configuration');
    if (method === 'cancelDiscovery') {
      if (!validDiscoveryOperation(args[0])) return discoveryError('invalid_configuration');
      if (this.inspection?.kind === 'discovery' && this.inspection.id === args[0]) this.inspection.controller.abort();
      return discoveryError('cancelled');
    }
    if (!record(args[0]) || Object.keys(args[0]).length !== 3) return discoveryError('invalid_configuration');
    const { operationID, connectionID, expectedRevision } = args[0], input = { connectionID, expectedRevision };
    if (!validDiscoveryOperation(operationID) || !validDiscoveryInput(input)) return discoveryError('invalid_configuration');
    if (!this.service.discoverModels) return discoveryError('unavailable');
    if (this.writesBlocked) return discoveryError('publication_uncertain');
    if (this.inspection || this.pending || this.writing) return discoveryError('busy');
    return this.runInspection('discovery', operationID, signal => this.service.discoverModels!(input, signal), discoveryError('cancelled'), discoveryError('unavailable'));
  }
  async invokeProbe(method: keyof typeof modelProbeIPC, trusted: boolean, args: unknown[]): Promise<ModelProbeReply> {
    if (!trusted) return probeError('unavailable');
    if (args.length !== 1) return probeError('invalid_configuration');
    if (method === 'cancelConnectionTest') {
      if (!validDiscoveryOperation(args[0])) return probeError('invalid_configuration');
      if (this.inspection?.kind === 'probe' && this.inspection.id === args[0]) this.inspection.controller.abort();
      return probeError('cancelled');
    }
    if (!record(args[0])) return probeError('invalid_configuration');
    const { operationID, ...input } = args[0];
    if (!validDiscoveryOperation(operationID) || !validProbeInput(input) || Buffer.byteLength(JSON.stringify(input)) > modelProbeBytes) return probeError('invalid_configuration');
    if (!this.service.testModelConnection) return probeError('unavailable');
    if (this.writesBlocked) return probeError('publication_uncertain');
    if (this.inspection || this.pending || this.writing) return probeError('busy');
    return this.runInspection('probe', operationID, async signal => {
      const result = await this.service.testModelConnection!(input, signal);
      return isProbeReply(result, input) ? result : probeError('unavailable');
    }, probeError('cancelled'), probeError('unavailable'));
  }
  private async runInspection<T>(kind: 'probe' | 'discovery', id: string, run: (signal: AbortSignal) => Promise<T>, cancelled: T, unavailable: T): Promise<T> {
    const controller = new AbortController(), active = { kind, id, controller };
    this.inspection = active;
    let cancel!: () => void;
    const aborted = new Promise<T>(resolve => {
      cancel = () => resolve(cancelled);
      controller.signal.addEventListener('abort', cancel, { once: true });
    });
    try {
      const result = await Promise.race([run(controller.signal), aborted]);
      return controller.signal.aborted ? cancelled : result;
    } catch { return controller.signal.aborted ? cancelled : unavailable; }
    finally {
      controller.signal.removeEventListener('abort', cancel);
      if (this.inspection === active) this.inspection = undefined;
    }
  }
  cancel(): void { this.cancelKey(); this.inspection?.controller.abort(); }
  private cancelKey(error: 'key_input_cancelled' | 'key_input_expired' = 'key_input_cancelled'): void {
    this.take()?.finish(failure(error));
    this.clipboardRead?.abort();
  }
  private fits(input: unknown): boolean { try { return Buffer.byteLength(JSON.stringify(input)) <= MODEL_BODY_LIMIT; } catch { return false; } }
  private prepare(input: ModelEdit): Promise<ModelWorkspaceReply> {
    return new Promise(finish => {
      const lifetime = this.native.expiresMs ?? 45_000;
      const deadline = performance.now() + lifetime;
      const pending = { input, finish, timer: setTimeout(() => this.cancelKey('key_input_expired'), lifetime) };
      this.pending = pending;
      const origin = new URL(input.connection.baseURL).origin;
      this.native.menuChanged({ origin, submit: ownsFocus => {
        if (!ownsFocus || this.pending !== pending) return;
        if (performance.now() >= deadline) { this.cancelKey('key_input_expired'); return; }
        this.take();
        void this.write(() => this.submit(pending)).then(finish);
      } });
    });
  }
  private take(): Pending | undefined {
    const pending = this.pending;
    if (pending) { this.pending = undefined; clearTimeout(pending.timer); this.native.menuChanged(); }
    return pending;
  }
  private async submit({ input }: Pending): Promise<ModelWorkspaceReply> {
    const read = new AbortController();
    this.clipboardRead = read;
    const timer = setTimeout(() => read.abort('timeout'), 2500);
    const abort = new Promise<undefined>(resolve => read.signal.addEventListener('abort', () => resolve(undefined), { once: true }));
    let key: string | undefined;
    try { key = await Promise.race([this.native.readClipboard(), abort]); }
    catch { return failure('clipboard_not_key'); }
    finally { clearTimeout(timer); this.clipboardRead = undefined; }
    if (read.signal.aborted) return failure(read.signal.reason === 'timeout' ? 'key_input_expired' : 'key_input_cancelled');
    if (typeof key !== 'string' || key.length > 8192 || !/^[\x21-\x7e]+$/.test(key)) return failure('clipboard_not_key');
    return this.service.saveModelConnection({ ...input, credential: { kind: 'replace', key } });
  }
  private async write(operation: () => Promise<ModelWorkspaceReply>): Promise<ModelWorkspaceReply> {
    this.writing = true;
    try {
      const result = await operation();
      if (!result.ok && result.error === 'publication_uncertain') this.writesBlocked = true;
      return result;
    }
    catch { return failure('write_outcome_unknown'); }
    finally { this.writing = false; }
  }
}
