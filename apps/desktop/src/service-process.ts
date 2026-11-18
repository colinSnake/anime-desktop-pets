import { isTaskFollowingState, type TaskFollowingState } from '../../app-service/src/codex-task-following.ts';
import { probeError, type ModelProbeInput, type ModelProbeReply } from '../../../packages/contracts/src/model-probe.ts';
import { chatUnavailable, requestChatModels, requestOnlineChat } from './chat-transport.ts';
import type { ChatListResult, ChatSendResult, OnlineChatInput } from '../../../packages/contracts/src/online-chat.ts';
import { recordRoutes, type RecordAction } from '../../../packages/contracts/src/character-records.ts';
import type { IdentityWriteAction } from '../../../packages/contracts/src/characters.ts';
import { identityUnavailable, identityWriteUnknown, requestIdentity, writeIdentity, requestCharacterRecords, requestKnowledgeSearch, requestLocalChatContext } from './character-transport.ts';
import { isSpeechResult, type SpeechResult } from "../../../packages/contracts/src/speech.ts";
import { discoveryError } from '../../app-service/src/models/discovery-contract.ts';
import type { ModelDiscoveryInput, ModelDiscoveryReply } from '../../../packages/contracts/src/models.ts';
import { interruptedModelRequest, requestModelDiscovery, requestModelManagement, requestModelProbe } from "./model-transport.ts";
import { managementError, type ModelAction, type ModelBridgeResult, type ModelInputs } from "../../app-service/src/models/management-contract.ts";
import { requestPets } from "./pet-transport.ts";
import type { PetMethod } from "./pet-ipc.ts";
import type { CatalogEntry, PetResult } from "../../../packages/contracts/src/pets.ts";
import { isPackageImportResult, shape, type PackageImportResult } from "../../../packages/contracts/src/pets.ts";
import { randomBytes } from "node:crypto";
import {
  isSnapshot,
  type Snapshot,
} from "../../../packages/contracts/src/index.ts";

export interface ServiceTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onExit(handler: (code?: number) => void): void;
  terminate(): void;
}
export class ServiceProcess {
  private readonly token = randomBytes(32).toString("hex");
  private transport?: ServiceTransport;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private exited: Promise<void> = Promise.resolve();
  private abortStart?: () => void;
  private port?: number;
  private closed = false;
  private hasExited = false;
  private exitCode?: number;
  private taskFollowingState: TaskFollowingState = 'off';
  constructor(
    private factory: () => ServiceTransport,
    private options: {
      modelsRoot?: string;
      taskFollowingHome?: string;
      onTaskFollowingState?: (state: TaskFollowingState) => void;
      speech?: { python: string; model: string; worker: string };
      workspace?: { root: string; catalog: CatalogEntry[]; packageToolPath?: string };
      workerPath: string;
      guardianPath: string;
      python?: string;
      player?: { workerPath: string; config?: import("../../app-service/src/player-runtime.ts").PlayerConfig };
      startupMs?: number;
      shutdownMs?: number;
    },
  ) {}

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("service_unavailable"));
    if (this.starting) return this.starting;
    this.starting = this.launch().catch(async () => {
      await this.close();
      throw new Error("service_unavailable");
    });
    return this.starting;
  }
  private launch(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const transport = this.factory();
      this.transport = transport;
      let finished = false;
      const timer = setTimeout(() => fail(), this.options.startupMs ?? 5000);
      const fail = () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          reject(new Error("service_unavailable"));
        }
      };
      this.abortStart = fail;
      let didExit!: () => void;
      this.exited = new Promise<void>((resolveExit) => {
        didExit = resolveExit;
      });
      transport.onExit((code) => {
        this.exitCode = code;
        this.hasExited = true;
        this.port = undefined;
        this.publishTaskFollowing('off');
        fail();
        didExit();
      });
      transport.onMessage((message) => {
        if (this.closed) return;
        if (finished) {
          if (this.port && this.options.taskFollowingHome && shape(message, ['type', 'state']) &&
              message.type === 'codex-task-following-state' && isTaskFollowingState(message.state)) this.publishTaskFollowing(message.state);
          return;
        }
        if (typeof message !== "object" || message === null) {
          fail();
          return;
        }
        const value = message as Record<string, unknown>;
        if (
          value.type !== "ready" ||
          !Number.isInteger(value.port) ||
          Number(value.port) < 1 ||
          Number(value.port) > 65535
        ) {
          fail();
          return;
        }
        this.port = Number(value.port);
        finished = true;
        clearTimeout(timer);
        resolve();
      });
      try {
        transport.send({
          type: "bootstrap",
          version: 1,
          token: this.token,
          workerPath: this.options.workerPath,
          guardianPath: this.options.guardianPath,
          python: this.options.python,
          player: this.options.player,
          workspace: this.options.workspace,
          modelsRoot: this.options.modelsRoot,
          speech: this.options.speech,
          taskFollowingHome: this.options.taskFollowingHome,
        });
      } catch {
        fail();
      }
    });
  }
  async request(command: "snapshot" | "probe" | "start-player" | "stop-player"): Promise<Snapshot> {
    if (this.closed || !this.port) throw new Error("service_unavailable");
    const paths = { snapshot: "/v1/snapshot", probe: "/v1/runtime/probe", "start-player": "/v1/player/start", "stop-player": "/v1/player/stop" };
    const path = paths[command];
    if (!path) throw new Error("service_unavailable");
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        method: command === "snapshot" ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(command !== "snapshot"
            ? { "content-type": "application/json" }
            : {}),
        },
        body: command !== "snapshot" ? "{}" : undefined,
        signal: AbortSignal.timeout(command === "start-player" ? 15_000 : 12_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error();
      const value: unknown = await response.json();
      if (!isSnapshot(value) || this.closed || !this.port) throw new Error();
      return value;
    } catch {
      throw new Error("service_unavailable");
    }
  }
  async readIdentity(input: unknown) {
    const port = this.port;
    if (this.closed || !port) return identityUnavailable;
    const result = await requestIdentity({ port, token: this.token }, input);
    return this.closed || this.port !== port ? identityUnavailable : result;
  }
  async writeIdentity(action: IdentityWriteAction, input: unknown) {
    const port = this.port;
    if (this.closed || !port) return identityUnavailable;
    const result = await writeIdentity({ port, token: this.token }, action, input);
    return this.closed || this.port !== port ? identityWriteUnknown : result;
  }
  async characterRecords(action: RecordAction, input: unknown) {
    const port = this.port;
    if (this.closed || !port) return identityUnavailable;
    const result = await requestCharacterRecords({ port, token: this.token }, action, input);
    return this.closed || this.port !== port ? recordRoutes[action].method === 'GET' ? identityUnavailable : identityWriteUnknown : result;
  }
  async searchKnowledge(input: unknown) {
    const port = this.port;
    if (this.closed || !port) return identityUnavailable;
    const result = await requestKnowledgeSearch({ port, token: this.token }, input);
    return this.closed || this.port !== port ? identityUnavailable : result;
  }
  async localChatContext(input: unknown) {
    const port = this.port;
    if (this.closed || !port) return identityUnavailable;
    const result = await requestLocalChatContext({ port, token: this.token }, input);
    return this.closed || this.port !== port ? identityUnavailable : result;
  }
  async listChatModels(): Promise<ChatListResult> {
    const port = this.port;
    if (this.closed || !port || !this.options.modelsRoot) return chatUnavailable;
    const result = await requestChatModels({ port, token: this.token });
    return this.closed || this.port !== port ? chatUnavailable : result;
  }
  async sendOnlineChat(input: OnlineChatInput, signal: AbortSignal): Promise<ChatSendResult> {
    const port = this.port;
    if (this.closed || !port || !this.options.modelsRoot) return chatUnavailable;
    const result = await requestOnlineChat({ port, token: this.token }, input, signal);
    return this.closed || this.port !== port ? chatUnavailable : result;
  }
  async speechRequest(method: 'status' | 'reference' | 'clear-reference' | 'enable' | 'disable', data?: unknown): Promise<SpeechResult> {
    const unavailable = { ok: false, error: 'unavailable' } as const;
    if (this.closed || !this.port) return unavailable;
    const url = `http://127.0.0.1:${this.port}/v1/speech/bubbles${method === 'status' ? '' : `/${method}`}`;
    try {
      const response = await fetch(url, {
        method: method === 'status' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(6500),
        headers: { authorization: `Bearer ${this.token}`, ...(method !== 'status' ? { 'content-type': 'application/json' } : {}) },
        body: method === 'status' ? undefined : JSON.stringify(data ?? {}),
      });
      const value: unknown = await response.json();
      return response.ok && isSpeechResult(value) && !this.closed && this.port ? value : unavailable;
    } catch { return unavailable; }
  }
  async petRequest(method: PetMethod, input?: unknown): Promise<PetResult> {
    if (this.closed || !this.port) return {ok:false,error:"unavailable"};
    const result = await requestPets({ base: `http://127.0.0.1:${this.port}`, token: this.token }, method, input);
    return this.closed || !this.port ? {ok:false,error:"unavailable"} : result;
  }
  async importPackages(paths: string[]): Promise<PackageImportResult> {
    if (this.closed || !this.port || !Array.isArray(paths) || paths.length < 1 || paths.length > 16 || !paths.every(path => typeof path === 'string' && path.length <= 4096) || paths.reduce((sum, path) => sum + Buffer.byteLength(path), 0) > 56 * 1024) return { ok: false, error: 'invalid' };
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/v1/pets/import`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      const value: unknown = await response.json();
      if (!isPackageImportResult(value) || (value.ok && !response.ok)) return { ok: false, error: 'unavailable' };
      return this.closed || !this.port ? { ok: false, error: 'unavailable' } : value;
    } catch { return { ok: false, error: 'unavailable' }; }
  }
  // Trusted main-process entrypoints only; intentionally not registered as IPC.
  listModels(): Promise<ModelBridgeResult> { return this.modelRequest('list', undefined); }
  saveModelConnection(input: ModelInputs['save']): Promise<ModelBridgeResult> { return this.modelRequest('save', input); }
  setModelDefault(input: ModelInputs['default']): Promise<ModelBridgeResult> { return this.modelRequest('default', input); }
  removeModelConnection(input: ModelInputs['remove']): Promise<ModelBridgeResult> { return this.modelRequest('remove', input); }
  async discoverModels(input: ModelDiscoveryInput, signal: AbortSignal): Promise<ModelDiscoveryReply> {
    const port = this.port;
    if (this.closed || !port || !this.options.modelsRoot) return discoveryError('unavailable');
    const result = await requestModelDiscovery({ port, token: this.token }, input, signal);
    return this.closed || this.port !== port ? discoveryError('unavailable') : result;
  }
  async testModelConnection(input: ModelProbeInput, signal: AbortSignal): Promise<ModelProbeReply> {
    const port = this.port;
    if (this.closed || !port || !this.options.modelsRoot) return probeError('unavailable');
    const result = await requestModelProbe({ port, token: this.token }, input, signal);
    return this.closed || this.port !== port ? probeError('unavailable') : result;
  }
  private async modelRequest<M extends ModelAction>(method: M, input: ModelInputs[M]): Promise<ModelBridgeResult> {
    const port = this.port;
    if (this.closed || !port || !this.options.modelsRoot) return managementError('unavailable');
    const result = await requestModelManagement({ port, token: this.token }, method, input);
    return this.closed || this.port !== port ? interruptedModelRequest(method) : result;
  }
  // Only the native main process can submit this fixed command to its owned utility process.
  setTaskFollowing(enabled: boolean): boolean {
    if (this.closed || !this.port || !this.transport || !this.options.taskFollowingHome || typeof enabled !== 'boolean') return false;
    try { this.transport.send({ type: 'codex-task-following', enabled }); return true; }
    catch { this.publishTaskFollowing('off'); return false; }
  }
  private publishTaskFollowing(state: TaskFollowingState): void {
    if (this.taskFollowingState === state) return;
    this.taskFollowingState = state;
    try { this.options.onTaskFollowingState?.(state); } catch { /* Status presentation cannot interrupt cleanup. */ }
  }
  private checkCleanup() {
    if (typeof this.exitCode === "number" && this.exitCode !== 0) throw new Error("service_cleanup_failed");
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.port = undefined;
    this.abortStart?.();
    this.publishTaskFollowing('off');
    this.closing = (async () => {
      if (!this.transport) return;
      if (this.hasExited) { this.checkCleanup(); return; }
      try {
        this.transport.send({ type: "shutdown" });
      } catch {
        /* 进程可能已退出。 */
      }
      if (await waitFor(this.exited, this.options.shutdownMs ?? 10_000)) { this.checkCleanup(); return; }
      this.transport.terminate();
      if (!(await waitFor(this.exited, 1500)))
        throw new Error("service_cleanup_timeout");
      this.checkCleanup();
    })();
    return this.closing;
  }
}
async function waitFor(exit: Promise<void>, timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
