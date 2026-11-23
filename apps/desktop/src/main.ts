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
  shell,
  utilityProcess,
} from "electron";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import {
  assetPath,
  CONTENT_SECURITY_POLICY,
  trustedCaller,
  trustedFrame,
  WINDOW_SECURITY,
  WORKSPACE_URL,
} from "./security.ts";
import { validPackagePickerArgs, validPetArgs } from "./pet-ipc.ts";
import { PetCoverProvider } from "./pet-cover.ts";
import { ServiceProcess } from "./service-process.ts";
import { ModelIPC, type ModelMenuIntent } from './model-ipc.ts';
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
import { WorkspaceDataFolder, workspaceProfilePath } from './workspace-data-folder.ts';
import { fitWorkspace, sameWorkspaceBounds, validWorkspaceBounds, WorkspacePlacement, workspaceDefault, workspaceMinimum, type WorkspaceBounds } from './workspace-placement.ts';
import { adjustWorkspacePlacement, watchWorkspaceDisplayChanges, type PlacementTrigger } from './workspace-display-recovery.ts';
import { resolveHarnessExecutable } from './harness-node.ts';

import { workspaceDevConfig, workspaceDevResponse } from './workspace-ui-hmr.ts';

const workspaceHmrActivation = process.env.PET_WORKSPACE_UI_HMR;
delete process.env.PET_WORKSPACE_UI_HMR;
const workspaceHmr = workspaceDevConfig(process.defaultApp === true && !app.isPackaged,
  process.argv.includes('--workspace-ui-hmr'), workspaceHmrActivation);

const workspaceVideoDirectory = process.env.PET_WORKSPACE_VIDEO_DIR;
delete process.env.PET_WORKSPACE_VIDEO_DIR;

app.setName("桌边小崽");
const appData = app.getPath("appData");
app.setPath("userData", workspaceProfilePath(appData));

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
let covers: PetCoverProvider | undefined;
let models: ModelIPC | undefined;
let chat: ChatIPC | undefined;
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
    linkage: (action, expectedRevision) => !exiting && service
      ? service.petRequest(action, { expectedRevision }) : Promise.resolve({ ok: false, error: 'unavailable' }),
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
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  covers = new PetCoverProvider(join(__dirname, 'branding', 'pet-cover.png'), video?.companionCover);
  protocol.handle("pet-app", async (request) => {
    const cover = await covers?.response(request.url, request.method);
    if (cover) return cover;
    const relative = assetPath(request.url);
    if (workspaceHmr && relative !== "assets/app-icon.svg") return workspaceDevResponse(workspaceHmr, request);
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
  const speech = await configuredSpeech();
  if (exiting) return;
  const harnessExecutable = resolveHarnessExecutable({
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    environment: process.env,
  });
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
      // DSH rc.5 does not support this Electron build's native fingerprint.
      harnessExecutable,
      modelsRoot: process.platform === "darwin" ? join(app.getPath("userData"), "models") : undefined,
      workspace: {
        root: join(app.getPath("userData"), "workspace"),
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
    const installModelMenu = (intent?: ModelMenuIntent) => Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'Codex', submenu: [{ label: '打开 Codex', click: requestCodexLaunch }] },
      { label: '模型', submenu: [{
        label: intent ? `保存剪贴板中的 API Key → ${intent.origin}` : '保存剪贴板中的 API Key',
        enabled: !!intent, click: () => intent?.submit(isWorkspaceVisible() && BrowserWindow.getFocusedWindow() === workspace),
      }] }, { role: 'windowMenu' },
    ]));
    models = new ModelIPC(service, { readClipboard: () => clipboard.readText(), menuChanged: installModelMenu });
    installModelMenu();
    chat = new ChatIPC(service);
    const cancelWorkspaceRequests = () => { models?.cancel(); chat?.cancel(); };
    workspace.webContents.on('did-start-navigation', cancelWorkspaceRequests);
    workspace.webContents.on('render-process-gone', cancelWorkspaceRequests);
    workspace.on('closed', cancelWorkspaceRequests);
    const trustedModelFrame = (event: Electron.IpcMainInvokeEvent, args: unknown[]) => !exiting && !!workspace && !workspace.isDestroyed() && trustedFrame({
        senderId: event.sender.id, ownerId: workspace.webContents.id, senderFrame: event.senderFrame,
        mainFrame: workspace.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      });
    registerWorkspaceModelIPC((channel, listener) => ipcMain.handle(channel, listener), {
      chat, models, trusted: trustedModelFrame, visible: isWorkspaceVisible,
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
  const workspaceData = new WorkspaceDataFolder(appData, path => shell.openPath(path));
  ipcMain.handle('pet:open-workspace-data', (event, ...args: unknown[]) => {
    const eligible = () => isWorkspaceVisible() && !!workspace && trustedCaller({
      senderId: event.sender.id, ownerId: workspace.webContents.id,
      senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame,
      url: event.senderFrame?.url ?? '', args,
    });
    if (!eligible()) throw new Error('forbidden');
    return workspaceData.open(eligible);
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
      const result = await service!.petRequest(method, args[0]);
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
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    for (const method of speechMethods) ipcMain.handle(`pet:speech-${method}`, async (event, ...args: unknown[]) => {
      const owner = workspace;
      if (!owner || owner.isDestroyed() || !trustedFrame({ senderId: event.sender.id, ownerId: owner.webContents.id,
        senderFrame: event.senderFrame, mainFrame: owner.webContents.mainFrame, url: event.senderFrame?.url ?? '', args,
      }) || !validSpeechArgs(method, args)) throw new Error('forbidden');
      if (method === 'status' || method === 'enable' || method === 'disable') return service!.speechRequest(method, args[0]);
      if (method === 'clearReference') return service!.speechRequest('clear-reference');
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
  void (async () => {
    try {
      // Keep the service's workspace ownership until window placement has settled.
      await placementSave;
      const results = await Promise.allSettled([trayCleanup, launchCleanup, service?.close()]);
      if (results.some(result => result.status === 'rejected')) dialog.showErrorBox(
        "本地服务清理失败",
        "未确认本应用子进程已完全退出，请检查开发日志。",
      );
    } finally {
      cleaned = true;
      app.quit();
    }
  })();
});
start().catch(async () => {
  const trayCleanup = workspaceStatus?.dispose();
  const launchCleanup = startupLaunch?.dispose();
  if (exiting) return;
  await Promise.allSettled([trayCleanup, launchCleanup, service?.close()]);
  dialog.showErrorBox(
    "桌边小崽启动失败",
    "本地工作区未能启动；未连接现有桌宠，也未修改用户资料。",
  );
  app.quit();
});
