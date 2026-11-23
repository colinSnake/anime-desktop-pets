import { WorkspaceVideoClient } from './workspace-video-client.ts';
import { CodexTaskFollowing } from './codex-task-following.ts';
import { CodexTaskReaderProcess } from './codex-task-reader-process.ts';
import { readCodexPresence } from './codex-presence.ts';
import { ChatHistory } from './chat-history.ts';
import { CharacterRepository } from "./characters/repository.ts";
import { BubbleSpeech } from "./speech/bubble-speech.ts";
import { isSpeechRuntimeConfig, LocalBubbleSpeechBackend } from "./speech/process-backend.ts";
/** 由 Electron utility process 或测试 Node fork 引导；不提供公共 CLI 服务。 */
import { PrivateDirectory } from './models/private-directory.ts';
import { ModelManagement } from "./models/management.ts";
import { MacKeychainBackend } from "./models/mac-keychain.ts";
import { PetWorkspace } from "./pet-workspace.ts";
import { catalogEntry, shape, type CatalogEntry } from "../../../packages/contracts/src/pets.ts";
import { PetLifecycle } from "./pet-lifecycle.ts";
import { dirname, isAbsolute, join } from "node:path";
import { createService } from "./server.ts";
import { createHarnessRuntime } from "./agent/harness-runtime.ts";
import { PythonRuntime } from "./python-runtime.ts";
import { PetPackageImporter } from "./pet-package-importer.ts";

import { longmei as defaultVideoPet, dafeiyu, samePetPackage } from "../../../packages/contracts/src/built-in-pets.ts";

type WorkspaceBootstrap = { root: string; catalog: CatalogEntry[]; packageToolPath?: string; packageProfileRoot?: string };
function validWorkspaceBootstrap(value: unknown): value is WorkspaceBootstrap {
  return shape(value, ["root", "catalog", "packageToolPath", "packageProfileRoot"]) && typeof value.root === "string" && isAbsolute(value.root) && Array.isArray(value.catalog) && value.catalog.length <= 32 && value.catalog.every(catalogEntry) && (value.packageToolPath === undefined || typeof value.packageToolPath === "string" && isAbsolute(value.packageToolPath)) && (value.packageProfileRoot === undefined || typeof value.packageProfileRoot === "string" && isAbsolute(value.packageProfileRoot));
}

type ParentPort = {
  on(event: "message", handler: (event: { data: unknown }) => void): void;
  postMessage(value: unknown): void;
};
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort })
  .parentPort;
const send = (value: unknown) => {
  if (parentPort) parentPort.postMessage(value);
  else process.send?.(value as object);
};
let service: ReturnType<typeof createService> | undefined;
let booting: Promise<void> | undefined;
let stopping = false;
let taskFollowing: CodexTaskFollowing | undefined;
let video: WorkspaceVideoClient | undefined;
const bootstrapTimer = setTimeout(() => {
  void stop();
}, 5000);
bootstrapTimer.unref();

async function stop() {
  if (stopping) return;
  stopping = true;
  taskFollowing?.setEnabled(false);
  clearTimeout(bootstrapTimer);
  let exitCode = 0;
  try {
    await booting?.catch(() => {});
    const cleanup = await Promise.allSettled([taskFollowing?.close(), service?.close()]);
    if (cleanup.some(result => result.status === 'rejected')) exitCode = 1;
  } catch {
    exitCode = 1; // Propagate unconfirmed cleanup without private exception text.
  } finally {
    process.exit(exitCode);
  }
}
function message(value: unknown) {
  if (typeof value !== "object" || value === null) {
    void stop();
    return;
  }
  const input = value as Record<string, unknown>;
  if (input.type === "shutdown") {
    void stop();
    return;
  }
  if (input.type === 'codex-task-following') {
    if (!stopping && shape(input, ['type', 'enabled']) && typeof input.enabled === 'boolean') taskFollowing?.setEnabled(input.enabled);
    return;
  }
  if (input.type === 'workspace-video-result' || input.type === 'workspace-video-ended' || input.type === 'workspace-video-drop' || input.type === 'workspace-video-cue' || input.type === 'workspace-video-menu') {
    if (!stopping || (input.type !== 'workspace-video-cue' && input.type !== 'workspace-video-menu')) video?.receive(input);
    return;
  }
  if (booting || stopping) return;
  if (
    input.type !== "bootstrap" ||
    input.version !== 1 ||
    typeof input.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.token) ||
    typeof input.guardianPath !== "string" ||
    !isAbsolute(input.guardianPath) ||
    typeof input.workerPath !== "string" ||
    !isAbsolute(input.workerPath) ||
    (input.python !== undefined && typeof input.python !== "string") ||
    (input.speech !== undefined && !isSpeechRuntimeConfig(input.speech)) ||
    Object.hasOwn(input, "player") ||
    (input.workspace !== undefined && !validWorkspaceBootstrap(input.workspace)) ||
    (input.workspaceVideo !== undefined && (input.workspaceVideo !== true || process.platform !== "darwin" ||
      !input.workspace)) ||
    (input.taskFollowingHome !== undefined && (typeof input.taskFollowingHome !== 'string' ||
      !isAbsolute(input.taskFollowingHome) || input.taskFollowingHome.includes('\0') || Buffer.byteLength(input.taskFollowingHome) > 3072)) ||
    (input.harnessExecutable !== undefined && (typeof input.harnessExecutable !== "string" ||
      !isAbsolute(input.harnessExecutable) || input.harnessExecutable.includes("\0") || Buffer.byteLength(input.harnessExecutable) > 4096)) ||
    (input.modelsRoot !== undefined && (typeof input.modelsRoot !== "string" || input.modelsRoot.length > 4096 || input.modelsRoot.includes("\0") || !isAbsolute(input.modelsRoot)))
  ) {
    void stop();
    return;
  }
  clearTimeout(bootstrapTimer);
  const { token, workerPath, guardianPath, python } = input;
  booting = (async () => {
    const speech = process.platform === 'darwin' && process.arch === 'arm64' && isSpeechRuntimeConfig(input.speech)
      ? new BubbleSpeech(new LocalBubbleSpeechBackend({ ...input.speech, guardian: guardianPath })) : undefined;
    let workspace: PetWorkspace | undefined;
    const playerSpeech = speech && {
      offer: (source: symbol, text: string, eligible: () => boolean) => speech.offer(source, text, () => workspace?.canStartOwnedPlayer() === true && eligible()),
      cancelSource: (source: symbol) => speech.cancelSource(source),
    };
    if (input.workspaceVideo === true) video = new WorkspaceVideoClient(send, undefined, playerSpeech);
    const workspaceOptions = input.workspace as WorkspaceBootstrap | undefined;
    const businessRoot = input.businessRoot;
    if (businessRoot !== undefined) {
      if (process.platform !== 'darwin' || typeof businessRoot !== 'string' || !isAbsolute(businessRoot) || businessRoot.includes('\0') ||
        workspaceOptions?.root !== join(businessRoot, 'workspace') || input.modelsRoot !== join(businessRoot, 'models')) throw new Error('invalid_data_root');
      await new PrivateDirectory(businessRoot, false).ready();
    }
    workspace = workspaceOptions ? await (async () => {
      const packageImporter = workspaceOptions.packageToolPath ? new PetPackageImporter({
        root: workspaceOptions.packageProfileRoot ?? workspaceOptions.root, scriptPath: workspaceOptions.packageToolPath, python: python as string | undefined,
      }) : undefined;
      const catalog = [...workspaceOptions.catalog];
      if (packageImporter) {
        for (const entry of await packageImporter.listCatalog()) {
          if (!catalog.some(item => item.id === entry.id && item.version === entry.version) && catalog.length < 32) catalog.push(entry);
        }
      }
      const lifecycle = new PetLifecycle({
        supports: pet => !!video && (samePetPackage(pet.package, defaultVideoPet) || samePetPackage(pet.package, dafeiyu)) &&
          workspaceOptions.catalog.some(entry => entry.launchable === true && samePetPackage(entry, pet.package)),
        create: pet => video!.controller(pet.id, pet.package),
      });
      return new PetWorkspace({ ...workspaceOptions, requirePrivate: businessRoot !== undefined, catalog, playerMode: video ? 'video' : undefined,
        importOne: packageImporter?.importOne.bind(packageImporter), lifecycle,
        onPauseRequested: () => { taskFollowing?.setEnabled(false); void speech?.pause().catch(() => {}); },
        stopAdditional: () => speech?.pause().then(() => true) ?? Promise.resolve(true),
      });
    })() : undefined;
    video?.setMenuHandler((id, intent, current) => { void workspace?.recordVideoMenu(id, intent, current); });
    if (process.platform === 'darwin' && workspace && typeof input.taskFollowingHome === 'string') {
      const runtimeDirectory = dirname(workerPath);
      const reader = new CodexTaskReaderProcess({ home: input.taskFollowingHome, guardian: guardianPath,
        worker: join(runtimeDirectory, 'task_reader_worker.py'), python: python as string | undefined });
      taskFollowing = new CodexTaskFollowing({ lease: workspace.taskLease,
        probe: signal => readCodexPresence(dirname(runtimeDirectory), undefined, signal),
        read: signal => reader.sample(signal), closeReader: () => reader.close(),
        pose: snapshot => workspace?.updateTaskAnimation(snapshot),
        changed: state => {
          if (!stopping) {
            try { send({ type: 'codex-task-following-state', state }); } catch { void stop(); }
          }
        },
      });
    }
    // Only the compiled CommonJS entry has a packaged native helper. Source-only
    // diagnostics can exercise management without enabling credential operations.
    const keychain = typeof __dirname === "string" ? new MacKeychainBackend(join(__dirname, "model-keychain")) : undefined;
    const models = process.platform === "darwin" && typeof input.modelsRoot === "string"
      ? new ModelManagement(input.modelsRoot, keychain) : undefined;
    service = createService({
      token,
      models,
      chatHistory: typeof businessRoot === 'string' ? new ChatHistory(businessRoot) : undefined,
      // The normal desktop service always composes the SDK route. Missing
      // Node/worker/SDK fails before reading a model Key.
      chatRuntime: models && createHarnessRuntime({
        worker: typeof __dirname === 'string' ? join(__dirname, 'harness-worker.mjs') : '',
        executable: typeof input.harnessExecutable === 'string' ? input.harnessExecutable : (parentPort ? '' : process.execPath),
        privateRoots: [businessRoot, input.modelsRoot, workspaceOptions?.root].filter((value): value is string => typeof value === 'string'),
      }),
      speech,
      characters: process.platform === "darwin" && workspaceOptions ? new CharacterRepository(join(workspaceOptions.root, "characters")) : undefined,
      workspace,
      runtime: new PythonRuntime({
        workerPath,
        guardianPath,
        python: python as string | undefined,
      }),
    });
    if (businessRoot && !(await workspace?.list())?.ok) throw new Error('workspace_storage_unavailable');
    await service.listen({ host: "127.0.0.1", port: 0 });
    const address = service.server.address();
    if (!address || typeof address === "string")
      throw new Error("startup_failed");
    if (!stopping) {
      // The parent accepts owned video commands only after the ready message.
      send({ type: "ready", port: address.port });
      if (video) void workspace?.startOnLaunch(defaultVideoPet);
    }
  })();
  booting.catch(() => {
    send({ type: "failed" });
    void stop();
  });
}
if (parentPort) parentPort.on("message", (event) => message(event.data));
else if (process.send) process.on("message", message);
else {
  clearTimeout(bootstrapTimer);
  process.exitCode = 1;
}
process.on("disconnect", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
