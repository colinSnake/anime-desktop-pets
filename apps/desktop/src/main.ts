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
  session,
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

app.setName("桌边小崽");
app.setPath(
  "userData",
  join(app.getPath("appData"), "AnimeDesktopPets", "cross-platform-dev"),
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pet-app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  ...(process.platform === 'darwin' ? [{ scheme: STARTUP_SCHEME,
    privileges: { standard: true, secure: true, stream: true },
  }] : []),
]);
let workspace: BrowserWindow | undefined;
let workspaceRevealable = false;
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

function revealWorkspace(): void {
  if (exiting || !workspaceRevealable || !workspace || workspace.isDestroyed()) return;
  if (workspace.isMinimized()) workspace.restore();
  workspace.show();
  workspace.focus();
}

function requestCodexLaunch(): void {
  if (!exiting && workspaceRevealable) void startupLaunch?.start();
}

async function start() {
  await app.whenReady();
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
  covers = new PetCoverProvider(process.env.PET_PLAYER_SOURCE && process.env.PET_PLAYER_ASSETS &&
    isAbsolute(process.env.PET_PLAYER_SOURCE) && isAbsolute(process.env.PET_PLAYER_ASSETS)
    ? { assets: process.env.PET_PLAYER_ASSETS, python: process.env.PET_PYTHON,
        workerPath: join(__dirname, "runtime", "pet_cover.py") } : undefined);
  protocol.handle("pet-app", async (request) => {
    const cover = await covers?.response(request.url, request.method);
    if (cover) return cover;
    const relative = assetPath(request.url);
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
      taskFollowingHome,
      onTaskFollowingState: state => { taskState = state; workspaceStatus?.render(); },
      modelsRoot: process.platform === "darwin" ? join(app.getPath("userData"), "models") : undefined,
      workspace: {
        root: join(app.getPath("userData"), "workspace"),
        packageToolPath: join(__dirname, 'runtime', 'pet_sources.py'),
        catalog: process.env.PET_PLAYER_SOURCE && process.env.PET_PLAYER_ASSETS && isAbsolute(process.env.PET_PLAYER_SOURCE) && isAbsolute(process.env.PET_PLAYER_ASSETS)
          ? [{id: "local.development.longmei", version: "0.0.0-dev", name: "龙妹开发配置", launchable: true}] : [],
      },
      workerPath: join(__dirname, "runtime", "worker.py"),
      guardianPath: join(__dirname, "runtime", "guardian.py"),
      python: process.env.PET_PYTHON,
      player: {
        workerPath: join(__dirname, "runtime", "player_worker.py"),
        config: process.env.PET_PLAYER_SOURCE && process.env.PET_PLAYER_ASSETS &&
          isAbsolute(process.env.PET_PLAYER_SOURCE) && isAbsolute(process.env.PET_PLAYER_ASSETS)
          ? { source: process.env.PET_PLAYER_SOURCE, assets: process.env.PET_PLAYER_ASSETS,
              profileRoot: join(app.getPath("userData"), "player-sessions") }
          : undefined,
      },
    },
  );
  await service.start();
  if (exiting) return;
  workspaceStatus?.serviceReady();
  workspace = new BrowserWindow({
    title: "桌边小崽",
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: windowColors.workspace,
    webPreferences: {
      ...WINDOW_SECURITY,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  workspace.removeMenu();
  workspace.on("close", event => workspaceStatus?.closeWindow(() => event.preventDefault()));
  const markWindowUnavailable = () => {
    workspaceRevealable = false;
    service?.setTaskFollowing(false);
    workspaceStatus?.windowUnavailable();
  };
  workspace.on("closed", () => { markWindowUnavailable(); void startupLaunch?.dispose(); });
  workspace.webContents.on("render-process-gone", markWindowUnavailable);
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
  workspace.webContents.on("will-navigate", (event) => event.preventDefault());
  workspace.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  for (const [channel, command] of [
    ["pet:snapshot", "snapshot"],
    ["pet:probe-runtime", "probe"],
    ["pet:start-player", "start-player"],
    ["pet:stop-player", "stop-player"],
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
  for (const method of ["list", "add", "clone", "delete", "save", "theme", "start", "stop", "applyDisplay", "applyBehavior", "visibility", "pause", "resume"] as const) {
    ipcMain.handle(`pet:pets-${method}`, (event, ...args: unknown[]) => {
      if (!workspace || workspace.isDestroyed() || !trustedFrame({
        senderId: event.sender.id, ownerId: workspace.webContents.id,
        senderFrame: event.senderFrame, mainFrame: workspace.webContents.mainFrame,
        url: event.senderFrame?.url ?? "", args,
      }) || !validPetArgs(method, args)) throw new Error("forbidden");
      return service!.petRequest(method, args[0]);
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
  const trayCleanup = workspaceStatus?.dispose();
  const launchCleanup = startupLaunch?.dispose();
  models?.cancel();
  chat?.cancel();
  void (async () => {
    try {
      const results = await Promise.allSettled([trayCleanup, launchCleanup, covers?.close(), service?.close()]);
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
  await Promise.allSettled([trayCleanup, launchCleanup, covers?.close(), service?.close()]);
  dialog.showErrorBox(
    "桌边小崽启动失败",
    "本地工作区未能启动；未连接现有桌宠，也未修改用户资料。",
  );
  app.quit();
});
