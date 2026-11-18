import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
  utilityProcess,
} from "electron";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
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
import { utilityTransport } from "./utility-transport.ts";

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
]);
let workspace: BrowserWindow | undefined;
let service: ServiceProcess | undefined;
let covers: PetCoverProvider | undefined;
let exiting = false;
let cleaned = false;

async function start() {
  await app.whenReady();
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
              : "text/html; charset=utf-8",
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
        },
      });
    } catch {
      return new Response("", { status: 404 });
    }
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
  workspace = new BrowserWindow({
    title: "桌边小崽",
    width: 1180,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    show: false,
    backgroundColor: "#12151c",
    webPreferences: {
      ...WINDOW_SECURITY,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  workspace.removeMenu();
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
  workspace.once("ready-to-show", () => {
    if (!exiting) workspace?.show();
  });
  await workspace.loadURL(WORKSPACE_URL);
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (cleaned) return;
  event.preventDefault();
  if (exiting) return;
  exiting = true;
  void (async () => {
    try {
      await Promise.all([covers?.close(), service?.close()]);
    } catch {
      dialog.showErrorBox(
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
  await Promise.all([covers?.close(), service?.close()]).catch(() => {});
  dialog.showErrorBox(
    "桌边小崽启动失败",
    "本地工作区未能启动；未连接现有桌宠，也未修改用户资料。",
  );
  app.quit();
});
