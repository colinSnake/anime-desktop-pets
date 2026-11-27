import { isLiveBindingInput, liveChannel, liveMethods, validLiveArgs } from '../../../packages/contracts/src/live-stage.ts';
import { LiveStageController } from './live-stage/controller.ts';
import { hasRequiredStageActions, liveStageMediaDirectory, loadStageAssets, stageArtworkName } from './live-stage/assets.ts';
import { openStageOutput } from './live-stage/output.ts';
import { LiveStagePreview } from './live-stage/preview.ts';
import { SpeechPreview } from './speech-preview.ts';
import { isSpeechEnableInput } from '../../../packages/contracts/src/speech.ts';
import { MicrophoneGate, isMicrophonePermission } from './microphone-gate.ts';
import { validMicWav } from './microphone-capture.ts';
import { VoiceDraftPicker, VoiceDraftSpeechGate, runVoiceTranscription } from './voice-draft.ts';
import { microphoneIPC, voiceDraftIPC } from '../../../packages/contracts/src/voice-draft.ts';
import { chatProjectIPC, isHistoryInput, isProjectListResult } from '../../../packages/contracts/src/chat-history.ts';
import { createChatProject } from './chat-project-directory.ts';
import { agentTaskChannel } from '../../../packages/contracts/src/agent-tasks.ts';
import { AgentTaskIPC } from './agent-task-ipc.ts';
import { passwordPasteMenu } from './password-paste-menu.ts';
import { dafeiyu, longmei } from '../../../packages/contracts/src/built-in-pets.ts';
import { prepareWorkspaceVideo } from './workspace-video-player.ts';
import { previewScheme } from './video-preview/media.ts';
import type { TaskFollowingState } from '../../app-service/src/codex-task-following.ts';
import { ChatIPC } from './chat-ipc.ts';
import { isLocalChatInput } from '../../../packages/contracts/src/local-chat.ts';
import { isRecordInput, recordActions } from '../../../packages/contracts/src/character-records.ts';
import { isKnowledgeSearchInput } from '../../../packages/contracts/src/knowledge-search.ts';
import { identityWriteActions, isIdentityWriteInput, validIdentityInput } from '../../../packages/contracts/src/characters.ts';
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  dialog,
  ipcMain,
  nativeImage,
  protocol,
  screen,
  session,
  systemPreferences,
  shell,
  utilityProcess,
} from "electron";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  assetPath,
  MICROPHONE_WORKLET_ASSET,
  CONTENT_SECURITY_POLICY,
  trustedCaller,
  trustedFrame,
  WINDOW_SECURITY,
  WORKSPACE_URL,
} from "./security.ts";
import { validPackagePickerArgs, validPetArgs } from "./pet-ipc.ts";
import { PetCoverProvider } from "./pet-cover.ts";
import { ServiceProcess } from "./service-process.ts";
import { ModelIPC } from './model-ipc.ts';
import { KnowledgeFilePicker } from "./knowledge-file.ts";
import { LegacyCharacterHandoff } from "./legacy-character-handoff.ts";
import { speechMethods, validSpeechArgs } from "./speech-ipc.ts";
import { utilityTransport } from "./utility-transport.ts";
import { registerWorkspaceModelIPC } from "./workspace-model-ipc.ts";
import { readCodexPresence } from "./codex-presence.ts";
import { readCodexWindowBounds } from "./codex-window-bounds.ts";
import { StartupLaunch, openInstalledCodex } from "./startup-launch.ts";
import { STARTUP_SCHEME } from "./startup-playback.ts";
import { installStartupPlayer } from "./startup-window.ts";
import { installWorkspaceTray } from "./workspace-tray.ts";
import { windowColors } from './window-colors.ts';
import { LocalDataRoot, type DataSelection } from './local-data-root.ts';
import { WorkspaceDataFolder, workspaceProfilePath } from './workspace-data-folder.ts';
import { fitWorkspace, sameWorkspaceBounds, validWorkspaceBounds, WorkspacePlacement, workspaceDefault, workspaceMinimum, type WorkspaceBounds } from './workspace-placement.ts';
import { adjustWorkspacePlacement, watchWorkspaceDisplayChanges, type PlacementTrigger } from './workspace-display-recovery.ts';

import { workspaceDevConfig, workspaceDevResponse } from './workspace-ui-hmr.ts';

const workspaceHmrActivation = process.env.PET_WORKSPACE_UI_HMR;
delete process.env.PET_WORKSPACE_UI_HMR;
const workspaceHmr = workspaceDevConfig(process.defaultApp === true && !app.isPackaged,
  process.argv.includes('--workspace-ui-hmr'), workspaceHmrActivation);

const workspaceVideoDirectory = process.env.PET_WORKSPACE_VIDEO_DIR;
delete process.env.PET_WORKSPACE_VIDEO_DIR;

app.setName("桌边小崽");
const appData = app.getPath("appData");
const electronProfile = workspaceProfilePath(appData);
app.setPath("userData", electronProfile);
const localData = process.platform === 'darwin' ? new LocalDataRoot(app.getPath('home'), electronProfile) : undefined;
const primary = !localData || app.requestSingleInstanceLock();
let data: DataSelection = { kind: 'legacy', root: electronProfile };
let confirmMigration = false;
let migrateAtQuit = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pet-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  ...(process.platform === 'darwin' ? [{ scheme: previewScheme,
    privileges: { standard: true, secure: true, stream: true },
  }] : []),
  ...(process.platform === 'darwin' ? [{ scheme: STARTUP_SCHEME,
    privileges: { standard: true, secure: true, stream: true },
  }] : []),
]);
let workspace: BrowserWindow | undefined;
let workspaceRevealable = false;
const placement = process.platform === 'darwin' ? new WorkspacePlacement(appData) : undefined;
let placementBaseline: WorkspaceBounds | undefined;
let placementAtClose: WorkspaceBounds | undefined;
let stopWorkspaceDisplayWatch: (() => void) | undefined;
let service: ServiceProcess | undefined;
let liveStage: LiveStageController | undefined;
let livePausing = 0;
async function pauseLiveStage() { await liveStage?.stop(); }
let covers: PetCoverProvider | undefined;
let models: ModelIPC | undefined;
let chat: ChatIPC | undefined;
let speechPreview: SpeechPreview | undefined;
let speechPreviewEpoch = 0;
const stopSpeechPreview = () => { speechPreviewEpoch++; return speechPreview?.stop() ?? Promise.resolve(true); };
let voiceDraftSpeechGate: VoiceDraftSpeechGate | undefined;
const speechForVoiceDraft = () => voiceDraftSpeechGate ??= new VoiceDraftSpeechGate(
  async () => await stopSpeechPreview() && (await service?.speechRequest('suspend'))?.ok === true,
  async preload => (await service?.speechRequest('resume', { preload }))?.ok === true,
);
let taskIPC: AgentTaskIPC | undefined;
let voiceDraft: VoiceDraftPicker | undefined;
let microphone: MicrophoneGate | undefined;
let micSystemPrompt = false;
const visibleMicrophoneOwner = (owner = workspace) => !!owner && owner === workspace && !exiting &&
  !owner.isDestroyed() && isWorkspaceVisible() && owner.isFocused() && !owner.isMinimized();
const micPermissionOwner = (contents: Electron.WebContents | null) => visibleMicrophoneOwner() && !!contents &&
  contents === workspace!.webContents && microphone?.canOpen() === true;
let workspaceStatus: ReturnType<typeof installWorkspaceTray>;
let startupLaunch: StartupLaunch | undefined;
let exiting = false;
let cleaned = false;

async function configuredSpeech() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const local = join(__dirname, '..', '..', '..', '.local', 'voice-runtime');
  const python = join(local, 'venv', 'bin', 'python');
  const model = join(local, 'models', 'Qwen3-TTS-12Hz-0.6B-Base-8bit');
  const worker = join(__dirname, 'runtime', 'speech', 'bubble_speech_worker.py');
  try {
    await access(python, constants.X_OK);
    if ((await stat(model)).isDirectory() && (await stat(worker)).isFile()) return { python, model, worker };
  } catch { /* Missing local runtime is a visible unavailable state. */ }
}

async function configuredVoiceDraft(): Promise<VoiceDraftPicker | undefined> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const local = join(__dirname, '..', '..', '..', '.local', 'voice-runtime');
  const python = join(local, 'venv', 'bin', 'python');
  const model = join(local, 'models', 'Qwen3-ASR-0.6B-8bit');
  const worker = join(__dirname, 'runtime', 'speech', 'voice_draft_worker.py');
  try {
    await access(python, constants.X_OK);
    if (!(await stat(worker)).isFile() || !(await stat(join(model, 'config.json'))).isFile() || !(await stat(join(model, 'model.safetensors'))).isFile()) return;
    return new VoiceDraftPicker((audio, signal) => runVoiceTranscription(python, ['-I', '-B', '-X', 'utf8', worker, model], audio, signal));
  } catch { /* No implicit install or network fallback. */ }
}

function isWorkspaceVisible(): boolean {
  return !exiting && workspaceRevealable && !!workspace && !workspace.isDestroyed() && workspace.isVisible();
}

function changedWorkspaceBounds(): WorkspaceBounds | undefined {
  if (!placementBaseline || !workspaceRevealable || !workspace || workspace.isDestroyed()) return;
  const current = workspace.getNormalBounds();
  if (validWorkspaceBounds(current) && !sameWorkspaceBounds(placementBaseline, current)) return current;
}

function recoverWorkspacePlacement(window: BrowserWindow, trigger: PlacementTrigger): void {
  if (!placement || exiting || !workspaceRevealable || window !== workspace) return;
  const adjustment = adjustWorkspacePlacement(window, trigger, () => ({
    primary: screen.getPrimaryDisplay().workArea, areas: screen.getAllDisplays().map(display => display.workArea),
  }));
  if (adjustment && (adjustment.relocated || (placementBaseline && sameWorkspaceBounds(placementBaseline, adjustment.before)))) {
    // Adapting to a different screen is not an explicit placement change.
    placementBaseline = adjustment.after;
  }
}

function revealWorkspace(): void {
  if (exiting || !workspaceRevealable || !workspace || workspace.isDestroyed()) return;
  const reopening = !workspace.isVisible() || workspace.isMinimized();
  if (workspace.isMinimized()) workspace.restore();
  if (reopening) recoverWorkspacePlacement(workspace, 'reopen');
  workspace.show();
  workspace.focus();
}

function requestCodexLaunch(): void {
  if (!exiting && workspaceRevealable) void startupLaunch?.start();
}

async function start() {
  await app.whenReady();
  if (exiting) return;
  if (localData) {
    try { data = await localData.select(); }
    catch { throw new Error('local_data_unavailable'); }
  }
  if (exiting) return;
  const video = process.platform === 'darwin' && workspaceVideoDirectory
    ? await prepareWorkspaceVideo(join(__dirname, 'video'), workspaceVideoDirectory).catch(() => undefined) : undefined;
  if (exiting) return;
  if (process.platform === 'darwin') {
    // This only updates our running development app; the bundle icon is a packaging concern.
    try {
      const icon = nativeImage.createFromPath(join(__dirname, 'branding', 'app-icon.png'));
      if (!icon.isEmpty()) app.dock?.setIcon(icon);
    } catch { /* Missing or invalid artwork must not block startup. */ }
    let player: ReturnType<typeof installStartupPlayer> | undefined;
    try {
      player = installStartupPlayer(join(__dirname, 'startup'), signal => readCodexWindowBounds(__dirname, signal));
    } catch { /* Keep launch available without playback. */ }
    startupLaunch = new StartupLaunch({
      presence: () => readCodexPresence(__dirname), play: () => player?.(), open: openInstalledCodex,
      report: result => dialog.showErrorBox('未能确认打开 Codex', result === 'failed'
        ? '系统未能打开 Codex，请确认已安装后重试。'
        : '未收到系统确认，请先检查 Codex 是否已经打开。'),
    });
  }
  let taskState: TaskFollowingState = 'off';
  const taskFollowingHome = process.platform === 'darwin' ? app.getPath('home') : undefined;
  workspaceStatus = installWorkspaceTray(join(__dirname, "branding", "petStatusTemplate.png"), {
    list: () => service!.petRequest("list"),
    linkage: async (action, expectedRevision) => {
      if (exiting || !service) return { ok: false, error: 'unavailable' };
      if (!await stopSpeechPreview() && action === 'resume') return { ok: false, error: 'apply-failed' };
      if (action !== 'pause') return service.petRequest(action, { expectedRevision });
      livePausing++;
      try { await pauseLiveStage(); return await service.petRequest(action, { expectedRevision }); }
      finally { livePausing--; }
    },
    readCodex: () => readCodexPresence(__dirname),
    launchCodex: requestCodexLaunch,
    taskFollowing: taskFollowingHome ? {
      state: () => taskState,
      setEnabled: enabled => !exiting && (!enabled || workspaceRevealable) && (service?.setTaskFollowing(enabled) ?? false),
    } : undefined,
    open: revealWorkspace,
    hide: () => { workspace?.hide(); models?.cancel(); chat?.cancel(); },
    quit: () => app.quit(),
  });
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => callback(micPermissionOwner(contents) &&
      isMicrophonePermission(permission, details, 'request') && microphone?.takeRequest() === true),
  );
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => micPermissionOwner(contents) &&
    isMicrophonePermission(permission, details, 'check', origin));
  covers = new PetCoverProvider(join(__dirname, 'branding', 'pet-cover.png'), video?.companionCover);
  protocol.handle("pet-app", async (request) => {
    const cover = await covers?.response(request.url, request.method);
    if (cover) return cover;
    const stageArtwork = process.platform === 'darwin' && request.method === 'GET' && stageArtworkName(request.url);
    if (stageArtwork) {
      try { return new Response(await readFile(join(__dirname, 'live-stage', stageArtwork)), { headers: {
        'content-type':'image/webp', 'content-security-policy':CONTENT_SECURITY_POLICY, 'x-content-type-options':'nosniff',
      }}); } catch { return new Response(null,{status:404}); }
    }
    const relative = assetPath(request.url);
    if (workspaceHmr && relative !== "assets/app-icon.svg" && relative !== MICROPHONE_WORKLET_ASSET) return workspaceDevResponse(workspaceHmr, request);
    if (request.method !== "GET" || !relative)
      return new Response("", { status: 404 });
    try {
      const data = await readFile(join(__dirname, "ui", relative));
      return new Response(data, {
        headers: {
          "content-type": relative.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : relative.endsWith(".css")
              ? "text/css; charset=utf-8"
              : relative.endsWith(".svg")
                ? "image/svg+xml"
                : "text/html; charset=utf-8",
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("", { status: 404 });
    }
  });
  const [speech, transcription] = await Promise.all([configuredSpeech(), configuredVoiceDraft()]);
  voiceDraft = transcription;
  if (exiting) return;
  service = new ServiceProcess(
    () => {
      const child = utilityProcess.fork(createRequire(__filename).resolve("@pet/app-service"), [], {
        serviceName: "桌边小崽本地服务",
        stdio: "pipe",
      });
      child.stdout?.resume();
      child.stderr?.resume();
      return utilityTransport(child);
    },
    {
      speech,
      videoHost: video?.host,
      taskFollowingHome,
      onTaskFollowingState: state => { taskState = state; workspaceStatus?.render(); },
      onExit: () => { void liveStage?.close().catch(() => {}); },
      modelsRoot: process.platform === "darwin" ? join(data.root, "models") : undefined,
      businessRoot: data.kind === 'adpets' ? data.root : undefined,
      workspace: {
        root: join(data.root, "workspace"),
        ...(data.kind === 'adpets' && { packageProfileRoot: join(electronProfile, 'workspace') }),
        packageToolPath: join(__dirname, 'runtime', 'pet_sources.py'),
        catalog: process.platform === 'darwin'
          ? [{ ...longmei, name: "龙妹", launchable: video?.longmeiReady === true },
            { ...dafeiyu, name: "鲸鱼妹", launchable: video?.companionReady === true }] : [],
      },
      workerPath: join(__dirname, "runtime", "worker.py"),
      guardianPath: join(__dirname, "runtime", "guardian.py"),
      python: process.env.PET_PYTHON,
    },
  );
  await service.start();
  if (exiting) return;
  workspaceStatus?.serviceReady();
  const savedPlacement = await placement?.read();
  if (exiting) return;
  const initialBounds = placement
    ? fitWorkspace(savedPlacement, screen.getPrimaryDisplay().workArea, screen.getAllDisplays().map(display => display.workArea))
    : workspaceDefault;
  workspace = new BrowserWindow({
    title: "",
    ...initialBounds,
    minWidth: Math.min(workspaceMinimum.width, initialBounds.width),
    minHeight: Math.min(workspaceMinimum.height, initialBounds.height),
    show: false,
    backgroundColor: windowColors.workspace,
    webPreferences: {
      ...WINDOW_SECURITY,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  // Keep the system frame and controls; the document title is not window chrome.
  workspace.accessibleTitle = "桌边小崽";
  workspace.on("page-title-updated", event => event.preventDefault());
  workspace.removeMenu();
  if (placement) {
    const window = workspace;
    stopWorkspaceDisplayWatch = watchWorkspaceDisplayChanges(notify => {
      screen.on('display-added', notify);
      screen.on('display-removed', notify);
      screen.on('display-metrics-changed', notify);
      window.on('restore', notify);
      window.on('unmaximize', notify);
      window.on('leave-full-screen', notify);
      return () => {
        screen.off('display-added', notify);
        screen.off('display-removed', notify);
        screen.off('display-metrics-changed', notify);
        window.off('restore', notify);
        window.off('unmaximize', notify);
        window.off('leave-full-screen', notify);
      };
    }, () => recoverWorkspacePlacement(window, 'display'));
  }
  workspace.on("close", event => {
    let hiding = false;
    workspaceStatus?.closeWindow(() => { hiding = true; event.preventDefault(); });
    if (!hiding) placementAtClose = changedWorkspaceBounds();
  });
  const markWindowUnavailable = () => {
    workspaceRevealable = false;
    stopWorkspaceDisplayWatch?.();
    service?.setTaskFollowing(false);
    workspaceStatus?.windowUnavailable();
  };
  workspace.on("closed", () => { markWindowUnavailable(); void startupLaunch?.dispose(); });
  workspace.webContents.on("render-process-gone", () => {
    placementAtClose = undefined;
    markWindowUnavailable();
  });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'Codex', submenu: [{ label: '打开 Codex', click: requestCodexLaunch }] },
      { role: 'windowMenu' },
    ]));
    models = new ModelIPC(service);
    if (process.arch === 'arm64') {
      speechPreview = new SpeechPreview(command => service!.speechRequest('preview', command));
    }
    chat = new ChatIPC(service);
    const tasks = taskIPC = new AgentTaskIPC(service.agentTask.bind(service));
    const cancelWorkspaceRequests = () => { liveStage?.cancelDanmaku(); void stopSpeechPreview(); microphone?.revoke(); models?.cancel(); chat?.cancel(); void voiceDraft?.cancel(); };
    workspace.on('hide', cancelWorkspaceRequests);
    workspace.on('minimize', cancelWorkspaceRequests);
    workspace.webContents.on('did-start-navigation', cancelWorkspaceRequests);
    workspace.webContents.on('render-process-gone', cancelWorkspaceRequests);
    workspace.on('closed', cancelWorkspaceRequests);
    const trustedModelFrame = (event: Electron.IpcMainInvokeEvent, args: unknown[]) => !exiting && !!workspace && !workspace.isDestroyed() && trustedFrame({
        senderId: event.sender.id, ownerId: workspace.webContents.id, senderFrame: event.senderFrame,
        mainFrame: workspace.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      });
    // Legacy records remain readable/cancellable, but only Chat can start new material work.
    for (const method of ['list', 'read', 'cancel'] as const) ipcMain.handle(agentTaskChannel(method), (event, ...args: unknown[]) =>
      tasks.invoke(method, () => trustedModelFrame(event, args) && isWorkspaceVisible() && !workspace!.isMinimized(), args));
    const owner = workspace;
    if (process.arch === 'arm64') {
      let micSpeechLease: { id: string; release: (preload: boolean) => Promise<boolean> } | undefined;
      const mic = microphone = new MicrophoneGate(id => {
        if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
          try { owner.webContents.send(microphoneIPC.revoked, id); } catch { /* Frame may already be gone. */ }
        }
        if (micSpeechLease?.id === id) {
          const lease = micSpeechLease;
          micSpeechLease = undefined;
          void (async () => {
            await voiceDraft?.cancel().catch(() => {});
            await lease.release(visibleMicrophoneOwner(owner));
          })();
        }
      });
      owner.on('blur', () => { mic.revoke(); void stopSpeechPreview(); });
      const currentMic = (event: Electron.IpcMainInvokeEvent, args: unknown[]) =>
        visibleMicrophoneOwner(owner) && trustedModelFrame(event, args);
      ipcMain.handle(microphoneIPC.authorize, async (event, ...args: unknown[]) => {
        if (args.length || !voiceDraft || !currentMic(event, args)) return { ok: false, error: 'unavailable' };
        if (mic.busy || micSystemPrompt || voiceDraft.busy || speechForVoiceDraft().busy) return { ok: false, error: 'busy' };
        switch (systemPreferences.getMediaAccessStatus('microphone')) {
          case 'granted': return { ok: true };
          case 'not-determined': break;
          default: return { ok: false, error: 'permission-denied' };
        }
        micSystemPrompt = true;
        try {
          // Only this explicit button can display the OS prompt. Never arm here.
          const granted = await systemPreferences.askForMediaAccess('microphone');
          return granted ? { ok: true } : { ok: false, error: 'permission-denied' };
        } catch { return { ok: false, error: 'failed' }; }
        finally { micSystemPrompt = false; }
      });
      ipcMain.handle(microphoneIPC.arm, async (event, ...args: unknown[]) => {
        if (args.length || !voiceDraft || !currentMic(event, args)) return { ok: false, error: 'unavailable' };
        const speechGate = speechForVoiceDraft();
        if (mic.busy || micSystemPrompt || voiceDraft.busy || speechGate.busy) return { ok: false, error: 'busy' };
        const status = systemPreferences.getMediaAccessStatus('microphone');
        if (status !== 'granted') return { ok: false, error: status === 'not-determined' ? 'permission-required' : 'permission-denied' };
        const release = await speechGate.acquire();
        if (!release) return { ok: false, error: speechGate.busy ? 'busy' : 'unavailable' };
        let retained = false;
        try {
          const id = await mic.armAfter(async () => true,
            () => currentMic(event, args) && !voiceDraft?.busy && !micSystemPrompt);
          if (!id) return { ok: false, error: 'unavailable' };
          micSpeechLease = { id, release };
          retained = true;
          return { ok: true, id };
        } finally {
          if (!retained) await release(visibleMicrophoneOwner(owner));
        }
      });
      ipcMain.handle(microphoneIPC.started, (event, ...args: unknown[]) => args.length === 1 && currentMic(event, args) && mic.started(args[0]));
      ipcMain.handle(microphoneIPC.finish, async (event, ...args: unknown[]) => {
        const [id, audio] = args;
        if (args.length !== 2 || !voiceDraft || !currentMic(event, args) || typeof id !== 'string' || id.length !== 36 || !validMicWav(audio)) {
          return { ok: false, error: 'cancelled' };
        }
        const signal = mic.finish(id);
        if (!signal) return { ok: false, error: 'cancelled' };
        try { return await voiceDraft.record(Buffer.from(audio), signal, () => currentMic(event, args)); }
        finally {
          mic.release(id);
          if (micSpeechLease?.id === id) {
            const lease = micSpeechLease;
            micSpeechLease = undefined;
            await lease.release(visibleMicrophoneOwner(owner));
          }
        }
      });
      ipcMain.handle(microphoneIPC.cancel, (event, ...args: unknown[]) => {
        if (args.length === 1 && owner === workspace && trustedModelFrame(event, args) && typeof args[0] === 'string') mic.revoke(args[0]);
      });
      ipcMain.handle(voiceDraftIPC.select, async (event, ...args: unknown[]) => {
        const current = () => owner === workspace && trustedModelFrame(event, args) && isWorkspaceVisible() && !owner.isMinimized();
        if (args.length || !voiceDraft || !current()) return { ok: false, error: 'unavailable' };
        const speechGate = speechForVoiceDraft();
        if (mic.busy || micSystemPrompt || speechGate.busy || voiceDraft.busy) return { ok: false, error: 'busy' };
        return voiceDraft.select(() => dialog.showOpenDialog(owner, {
          title: '选择语音 WAV（仅本机转写）', properties: ['openFile', 'noResolveAliases', 'dontAddToRecent'],
          filters: [{ name: 'PCM WAV', extensions: ['wav'] }],
        }), current, async () => {
          const release = await speechGate.acquire();
          return release ? () => release(visibleMicrophoneOwner(owner)) : undefined;
        });
      });
      ipcMain.handle(voiceDraftIPC.cancel, (event, ...args: unknown[]) => {
        if (!args.length && owner === workspace && trustedModelFrame(event, args)) void voiceDraft?.cancel();
      });
    }
    owner.webContents.on('context-menu', (_event, params) => {
      const eligible = owner === workspace && isWorkspaceVisible() && owner.isFocused() && trustedFrame({
        ownerId: owner.webContents.id, senderId: owner.webContents.id, senderFrame: params.frame,
        mainFrame: owner.webContents.mainFrame, url: params.frameURL, args: [],
      });
      const menu = passwordPasteMenu(eligible, params);
      if (menu) Menu.buildFromTemplate(menu).popup({ window: owner, x: params.x, y: params.y });
    });
    // A modal selection does not survive a hidden window, reload or host replacement.
    let projectSelection = false;
    let projectEpoch = 0;
    const invalidateProject = () => { projectEpoch++; };
    owner.on('hide', invalidateProject);
    owner.on('minimize', invalidateProject);
    owner.on('closed', invalidateProject);
    owner.webContents.on('did-start-navigation', invalidateProject);
    owner.webContents.on('render-process-gone', invalidateProject);
    ipcMain.handle(chatProjectIPC.list, async (event, ...args: unknown[]) => {
      const epoch = projectEpoch;
      const eligible = () => projectEpoch === epoch && trustedModelFrame(event, args) && isWorkspaceVisible() && !owner.isMinimized();
      if (!eligible() || args.length !== 1 || !isHistoryInput('projects', args[0])) return { ok: false, error: 'invalid_request' };
      const result = await service!.chatHistory('projects', args[0]);
      return eligible() && isProjectListResult(result) ? result : { ok: false, error: 'unavailable' };
    });
    ipcMain.handle(chatProjectIPC.create, async (event, ...args: unknown[]) => {
      const epoch = projectEpoch;
      const eligible = () => projectEpoch === epoch && trustedModelFrame(event, args) && isWorkspaceVisible() && !owner.isMinimized();
      if (!eligible() || args.length !== 1) return { ok: false, error: 'invalid_request' };
      if (projectSelection) return { ok: false, error: 'busy' };
      projectSelection = true;
      try {
        return await createChatProject(args[0], {
          eligible,
          select: () => dialog.showOpenDialog(owner, { title: '选择新项目文件夹的保存位置', properties: ['openDirectory', 'noResolveAliases', 'dontAddToRecent'] }),
          list: input => service!.chatHistory('projects', input),
          register: input => service!.chatHistory('createProject', input),
        });
      } finally { projectSelection = false; }
    });
    registerWorkspaceModelIPC((channel, listener) => ipcMain.handle(channel, listener), {
      chat, history: chat, material: chat, models, trusted: trustedModelFrame, visible: () => isWorkspaceVisible() && !owner.isMinimized(),
    });
  }

  workspace.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  workspace.webContents.on("will-navigate", (event) => {
    // Vite may fall back to reloading this exact renderer document.
    if (!workspaceHmr || event.url !== WORKSPACE_URL) event.preventDefault();
  });
  workspace.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  for (const [channel, command] of [
    ["pet:snapshot", "snapshot"],
    ["pet:probe-runtime", "probe"],
  ] as const) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        !workspace ||
        workspace.isDestroyed() ||
        !trustedCaller({
          senderId: event.sender.id,
          ownerId: workspace.webContents.id,
          senderFrame: event.senderFrame,
          mainFrame: workspace.webContents.mainFrame,
          url: event.senderFrame?.url ?? "",
          args,
        })
      )
        throw new Error("forbidden");
      return service!.request(command);
    });
  }
  if (process.platform === 'darwin') {
    const preview = new LiveStagePreview();
    liveStage = new LiveStageController({
      profile: (input,role) => service!.liveProfile(input,role),
      ...(speech && data.kind === 'adpets' && {voice: signal => service!.liveVoice(signal), danmaku: (role,text,scene,signal,synthesizing) => service!.liveDanmaku(role,text,scene,signal,synthesizing)}),
      allowed: async () => {
        if (exiting || livePausing) return false;
        const result = await service!.petRequest('list');
        return !exiting && !livePausing && result.ok && result.workspace.linkage === 'active';
      },
      open: async (role,clock,current) => {
        if (!workspaceVideoDirectory || (role === 'longmei' ? !video?.longmeiReady : !video?.companionReady || !hasRequiredStageActions('dafeiyu',video.companionClips))) throw new Error('stage_media_unavailable');
        const mediaDirectory = liveStageMediaDirectory(workspaceVideoDirectory,role);
        const assets = await loadStageAssets(join(__dirname,'live-stage'), mediaDirectory, role);
        if (!current()) throw new Error('stage_cancelled');
        return openStageOutput(clock, assets);
      },
      preview: (url,role) => preview.open(url,role), closePreview: () => preview.close(), copy: url => clipboard.writeText(url),
    });
    for (const method of liveMethods) ipcMain.handle(liveChannel(method), (event, ...args: unknown[]) => {
      const eligible = () => !exiting && !!workspace && !workspace.isDestroyed() && isWorkspaceVisible() && trustedFrame({
        senderId:event.sender.id, ownerId:workspace.webContents.id, senderFrame:event.senderFrame,
        mainFrame:workspace.webContents.mainFrame, url:event.senderFrame?.url ?? '', args,
      });
      if (!eligible() || !validLiveArgs(method,args)) throw new Error('forbidden');
      return liveStage!.run(method,args[0],eligible,args.at(-1));
    });
    const liveBindingCaller=(event:Electron.IpcMainInvokeEvent,args:unknown[])=>!exiting&&!!workspace&&!workspace.isDestroyed()&&isWorkspaceVisible()&&trustedFrame({senderId:event.sender.id,ownerId:workspace.webContents.id,senderFrame:event.senderFrame,mainFrame:workspace.webContents.mainFrame,url:event.senderFrame?.url??'',args});
    ipcMain.handle('pet:live-role-bindings-read',(event,...args:unknown[])=>{if(args.length||!liveBindingCaller(event,args))throw new Error('forbidden');return service!.liveRoleBindings();});
    ipcMain.handle('pet:live-role-bindings-write',(event,...args:unknown[])=>{if(args.length!==1||!liveBindingCaller(event,args)||!isLiveBindingInput(args[0]))throw new Error('forbidden');return service!.liveRoleBindings(args[0]);});
  }
  const workspaceData = new WorkspaceDataFolder(appData, path => shell.openPath(path), data.kind === 'adpets' ? data.root : undefined);
  const dataCaller = (event: Electron.IpcMainInvokeEvent, args: unknown[]) => isWorkspaceVisible() && !!workspace && trustedCaller({
      senderId: event.sender.id, ownerId: workspace.webContents.id,
      senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame,
      url: event.senderFrame?.url ?? '', args,
    });
  ipcMain.handle('pet:open-workspace-data', (event, ...args: unknown[]) => {
    const eligible = () => dataCaller(event, args);
    if (!eligible()) throw new Error('forbidden');
    return workspaceData.open(eligible);
  });
  if (localData) ipcMain.handle('pet:migrate-workspace-data', async (event, ...args: unknown[]) => {
    const owner = workspace;
    if (!owner || !dataCaller(event, args)) throw new Error('forbidden');
    if (data.kind !== 'legacy') return 'not-needed';
    if (confirmMigration || migrateAtQuit) return 'busy';
    confirmMigration = true;
    try {
      const { response } = await dialog.showMessageBox(owner, {
        type: 'warning', title: '迁移本机数据', message: '将工作区数据迁移到 ~/.adpets？',
        detail: '应用会先结束本地服务再迁移。旧资料会保留为备份，不会读取或复制钥匙串密钥。迁移后请手动重开；当前未保存的草稿和内存聊天不会保留。',
        buttons: ['取消', '迁移并退出'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (response !== 1 || !dataCaller(event, args)) return 'cancelled';
      migrateAtQuit = true;
      setImmediate(() => app.quit());
      return 'closing';
    } catch { return 'unavailable'; }
    finally { confirmMigration = false; }
  });
  if (process.platform === 'darwin') {
    const handoff = new LegacyCharacterHandoff(appData, (id, write) => service!.legacyCharacterHandoff(id, write));
    workspace.on('hide', () => handoff.invalidate());
    workspace.on('closed', () => handoff.invalidate());
    workspace.webContents.on('did-start-navigation', () => handoff.invalidate());
    workspace.webContents.on('render-process-gone', () => handoff.invalidate());
    ipcMain.handle('pet:legacy-character-handoff', (event, ...args: unknown[]) => {
      const owner = workspace;
      const eligible = () => !exiting && owner !== undefined && owner === workspace && !owner.isDestroyed() && isWorkspaceVisible() && trustedFrame({
        senderId: event.sender.id, ownerId: owner.webContents.id, senderFrame: event.senderFrame,
        mainFrame: owner.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      });
      if (!owner || !eligible() || args.length !== 1) throw new Error('forbidden');
      return handoff.handle(args[0], () => dialog.showOpenDialog(owner, {
        title: '选择旧版角色资料快照', properties: ['openDirectory', 'noResolveAliases', 'dontAddToRecent'],
      }), eligible);
    });
  }
  for (const method of ["list", "add", "clone", "delete", "save", "theme", "start", "stop", "applyDisplay", "applyBehavior", "visibility", "pause", "resume"] as const) {
    ipcMain.handle(`pet:pets-${method}`, async (event, ...args: unknown[]) => {
      if (!workspace || workspace.isDestroyed() || !trustedFrame({
        senderId: event.sender.id, ownerId: workspace.webContents.id,
        senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame,
        url: event.senderFrame?.url ?? "", args,
      }) || !validPetArgs(method, args)) throw new Error("forbidden");
      if (method === "pause" || method === "delete") { void stopSpeechPreview(); }
      // Reopening the service gate must not admit an offer issued before pause.
      if (method === "resume" && !await stopSpeechPreview()) return { ok: false, error: 'apply-failed' };
      const result = await (async () => {
        if (method !== 'pause') return service!.petRequest(method,args[0]);
        livePausing++;
        try { await pauseLiveStage(); return await service!.petRequest(method,args[0]); }
        finally { livePausing--; }
      })();
      if (method !== "list") void workspaceStatus?.refresh();
      return result;
    });
  }
  ipcMain.handle('pet:pets-importPackages', async (event, ...args: unknown[]) => {
    if (!workspace || workspace.isDestroyed() || !trustedFrame({
      senderId: event.sender.id, ownerId: workspace.webContents.id,
      senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame,
      url: event.senderFrame?.url ?? '', args,
    }) || !validPackagePickerArgs(args)) throw new Error('forbidden');
    const selection = await dialog.showOpenDialog(workspace, {
      title: '选择桌宠素材',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: '桌宠素材包', extensions: ['petpack'] }],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { ok: true, items: [] };
    if (selection.filePaths.length > 16) return { ok: false, error: 'limit' };
    return service!.importPackages(selection.filePaths);
  });
  if (process.platform === 'darwin') for (const action of ['readIdentity', 'searchKnowledge', 'localChatContext', ...identityWriteActions, ...recordActions] as const) {
    ipcMain.handle(`pet:characters-${action}`, (event, ...args: unknown[]) => {
      if (exiting || !workspace || workspace.isDestroyed() || !trustedFrame({ senderId: event.sender.id, ownerId: workspace.webContents.id,
        senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      }) || args.length !== 1) throw new Error('forbidden');
      if (action === 'localChatContext') {
        if (isLocalChatInput(args[0])) return service!.localChatContext(args[0]);
        throw new Error('forbidden');
      }
      if (action === 'searchKnowledge') {
        if (isKnowledgeSearchInput(args[0])) return service!.searchKnowledge(args[0]);
        throw new Error('forbidden');
      }
      if (action === 'readIdentity' && validIdentityInput(args[0])) return service!.readIdentity(args[0]);
      if ((action === 'saveIdentity' || action === 'restoreIdentity' || action === 'setIdentityChatShare') && isIdentityWriteInput(action, args[0])) return service!.writeIdentity(action, args[0]);
      if (action !== 'readIdentity' && action !== 'saveIdentity' && action !== 'restoreIdentity' && action !== 'setIdentityChatShare' && isRecordInput(action, args[0])) return service!.characterRecords(action, args[0]);
      throw new Error('forbidden');
    });
  }
  if (process.platform === 'darwin') {
    const picker = new KnowledgeFilePicker();
    ipcMain.handle('pet:characters-selectKnowledgeFile', (event, ...args: unknown[]) => {
      const owner = workspace;
      const current = () => !exiting && owner !== undefined && owner === workspace && !owner.isDestroyed() && trustedFrame({
        senderId: event.sender.id, ownerId: owner.webContents.id, senderFrame: event.senderFrame,
        mainFrame: owner.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      });
      if (!owner || !current() || args.length !== 0) throw new Error('forbidden');
      return picker.select(() => dialog.showOpenDialog(owner, {
        title: '选择角色知识文本', properties: ['openFile', 'noResolveAliases', 'dontAddToRecent'],
        filters: [{ name: '纯文本与 Markdown', extensions: ['txt', 'md'] }],
      }), current);
    });
  }
  let selectingReference = false;
  let speechChanging = false;
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    for (const method of speechMethods) ipcMain.handle(`pet:speech-${method}`, async (event, ...args: unknown[]) => {
      const owner = workspace;
      if (!owner || owner.isDestroyed() || !trustedFrame({ senderId: event.sender.id, ownerId: owner.webContents.id,
        senderFrame: event.senderFrame, mainFrame: owner.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      }) || !validSpeechArgs(method, args)) throw new Error('forbidden');
      if (method === 'status') return service!.speechRequest(method);
      if (method === 'stopPreview') {
        if (!await stopSpeechPreview()) return { ok: false, error: 'unavailable' };
        return service!.speechRequest('status');
      }
      if (method === 'preview') {
        const epoch = speechPreviewEpoch;
        const eligible = () => speechPreviewEpoch === epoch && visibleMicrophoneOwner(owner) && !speechChanging &&
          !selectingReference && !microphone?.busy && !micSystemPrompt && !voiceDraft?.busy && !speechForVoiceDraft().busy;
        return speechPreview?.play(eligible) ?? { ok: false, error: 'unavailable' };
      }
      if (method === 'enable' || method === 'disable') {
        if (speechChanging) return { ok: false, error: 'busy' };
        if (method === 'enable' && (!isSpeechEnableInput(args[0]) || !isWorkspaceVisible() || !owner.isFocused())) return { ok: false, error: 'unavailable' };
        speechChanging = true;
        try {
          if (method === 'disable') await stopSpeechPreview();
          if (method === 'enable' && (!await stopSpeechPreview() || !isWorkspaceVisible() || !owner.isFocused()))
            return { ok: false, error: 'unavailable' };
          const result = await service!.speechRequest(method, args[0]);
          return result;
        } finally { speechChanging = false; }
      }
      if (method === 'clearReference') return service!.speechRequest('clear-reference');
      if (method === 'saveTranscript') return service!.speechRequest('transcript', args[0]);
      if (selectingReference) return { ok: false, error: 'busy' };
      selectingReference = true;
      try {
        const current = await service!.speechRequest('status');
        if (!current.ok || current.speech.state === 'unavailable') return { ok: false, error: 'unavailable' };
        if (['enabled', 'loading', 'speaking'].includes(current.speech.state)) return { ok: false, error: 'busy' };
        if (exiting || owner.isDestroyed() || workspace !== owner) return { ok: false, error: 'unavailable' };
        const selection = await dialog.showOpenDialog(owner, { title: '选择桌宠播报的参考音频', properties: ['openFile'], filters: [{ name: 'PCM WAV 音频', extensions: ['wav'] }] });
        if (exiting || owner.isDestroyed() || workspace !== owner) return { ok: false, error: 'unavailable' };
        if (selection.canceled) return service!.speechRequest('status');
        const path = selection.filePaths[0];
        if (selection.filePaths.length !== 1 || !path || path.length > 4096 || !isAbsolute(path)) return { ok: false, error: 'invalid-audio' };
        return service!.speechRequest('reference', { path });
      } catch { return { ok: false, error: 'unavailable' }; }
      finally { selectingReference = false; }
    });
  }
  workspace.once("ready-to-show", () => {
    if (exiting) return;
    workspaceRevealable = true;
    workspace?.show();
    if (placement && workspace) {
      placementBaseline = workspace.getNormalBounds();
      recoverWorkspacePlacement(workspace, 'display');
    }
    void workspaceStatus?.windowReady();
    if (process.argv.includes('--launch-codex')) requestCodexLaunch();
  });
  await workspace.loadURL(WORKSPACE_URL);
}
app.on("activate", revealWorkspace);
app.on("second-instance", revealWorkspace);
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (cleaned) return;
  event.preventDefault();
  if (exiting) return;
  exiting = true;
  stopWorkspaceDisplayWatch?.();
  const boundsToSave = workspaceRevealable ? changedWorkspaceBounds() : placementAtClose;
  const placementSave = boundsToSave && placement?.save(boundsToSave);
  const trayCleanup = workspaceStatus?.dispose();
  const launchCleanup = startupLaunch?.dispose();
  models?.cancel();
  chat?.cancel();
  taskIPC?.invalidateCreate();
  microphone?.revoke();
  const voiceCleanup = voiceDraft?.cancel();
  const previewCleanup = stopSpeechPreview();
  const liveCleanup = liveStage?.close();
  void (async () => {
    try {
      // Keep the service's workspace ownership until window placement has settled.
      await placementSave;
      const results = await Promise.allSettled([trayCleanup, launchCleanup, voiceCleanup, previewCleanup, liveCleanup, service?.close()]);
      if (results.some(result => result.status === 'rejected')) dialog.showErrorBox(
        "本地服务清理失败",
        "未确认本应用子进程已完全退出，没有开始迁移。",
      );
      else if (migrateAtQuit && localData && service) {
        try {
          await localData.migrate();
          dialog.showMessageBoxSync({ type: 'info', message: '本机数据已迁移', detail: '旧资料已保留为备份。请重新打开桌边小崽。' });
        } catch {
          dialog.showErrorBox('未能确认数据迁移', '旧资料未被覆盖或删除。请重开应用核对；若仍提示数据目录异常，请先保留两处资料，不要手动合并。');
        }
      }
    } finally {
      cleaned = true;
      app.quit();
    }
  })();
});
if (!primary) { cleaned = true; app.quit(); }
else start().catch(async error => {
  const trayCleanup = workspaceStatus?.dispose();
  const launchCleanup = startupLaunch?.dispose();
  if (exiting) return;
  microphone?.revoke();
  await Promise.allSettled([trayCleanup, launchCleanup, voiceDraft?.cancel(), liveStage?.close(), service?.close()]);
  dialog.showErrorBox(
    "桌边小崽启动失败",
    error instanceof Error && error.message === 'local_data_unavailable'
      ? "无法安全确认本机数据目录。请保留 ~/.adpets 和旧的应用资料，不要手动合并。"
      : "本地工作区未能启动；未连接现有桌宠。",
  );
  app.quit();
});
