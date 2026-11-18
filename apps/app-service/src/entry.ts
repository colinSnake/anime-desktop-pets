/** 由 Electron utility process 或测试 Node fork 引导；不提供公共 CLI 服务。 */
import { PetWorkspace } from "./pet-workspace.ts";
import { catalogEntry, shape, type CatalogEntry } from "../../../packages/contracts/src/pets.ts";
import { PetLifecycle } from "./pet-lifecycle.ts";
import { isAbsolute, join } from "node:path";
import { createService } from "./server.ts";
import { PlayerRuntime, validPlayerConfig } from "./player-runtime.ts";
import { PythonRuntime } from "./python-runtime.ts";
import { PetPackageImporter } from "./pet-package-importer.ts";

type WorkspaceBootstrap = { root: string; catalog: CatalogEntry[]; packageToolPath?: string };
function validWorkspaceBootstrap(value: unknown): value is WorkspaceBootstrap {
  return shape(value, ["root", "catalog", "packageToolPath"]) && typeof value.root === "string" && isAbsolute(value.root) && Array.isArray(value.catalog) && value.catalog.length <= 32 && value.catalog.every(catalogEntry) && (value.packageToolPath === undefined || typeof value.packageToolPath === "string" && isAbsolute(value.packageToolPath));
}
type PlayerBootstrap = { workerPath: string; config?: import("./player-runtime.ts").PlayerConfig };
function validPlayerBootstrap(value: unknown): value is PlayerBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const player = value as Record<string, unknown>;
  return Object.keys(player).every(key => key === "workerPath" || key === "config") &&
    typeof player.workerPath === "string" && isAbsolute(player.workerPath) &&
    (player.config === undefined || validPlayerConfig(player.config));
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
const bootstrapTimer = setTimeout(() => {
  void stop();
}, 5000);
bootstrapTimer.unref();

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(bootstrapTimer);
  let exitCode = 0;
  try {
    await booting?.catch(() => {});
    await service?.close();
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
    (input.player !== undefined && !validPlayerBootstrap(input.player)) ||
    (input.workspace !== undefined && !validWorkspaceBootstrap(input.workspace))
  ) {
    void stop();
    return;
  }
  clearTimeout(bootstrapTimer);
  const { token, workerPath, guardianPath, python } = input;
  booting = (async () => {
    const player = new PlayerRuntime({
      workerPath: (input.player as PlayerBootstrap | undefined)?.workerPath ?? workerPath,
      guardianPath,
      python: python as string | undefined,
      config: (input.player as PlayerBootstrap | undefined)?.config,
    });
    const workspace = input.workspace ? await (async () => {
      const workspaceOptions = input.workspace as WorkspaceBootstrap;
      const packageImporter = workspaceOptions.packageToolPath ? new PetPackageImporter({
        root: workspaceOptions.root, scriptPath: workspaceOptions.packageToolPath, python: python as string | undefined,
      }) : undefined;
      const catalog = [...workspaceOptions.catalog];
      if (packageImporter) {
        for (const entry of await packageImporter.listCatalog()) {
          if (!catalog.some(item => item.id === entry.id && item.version === entry.version) && catalog.length < 32) catalog.push(entry);
        }
      }
      const lifecycle = new PetLifecycle({
        supports: pet => process.platform === "darwin" && !!(input.player as PlayerBootstrap | undefined)?.config &&
          pet.package.id === "local.development.longmei" && pet.package.version === "0.0.0-dev",
        create: pet => {
          const configured = input.player as PlayerBootstrap;
          return new PlayerRuntime({ guardianPath, workerPath: configured.workerPath, python: python as string | undefined,
            config: { ...configured.config!, profileRoot: join(configured.config!.profileRoot, "instances", pet.id) },
            initialPreferences: { size: pet.preferences.size, hideInFullscreen: pet.preferences.hideInFullscreen, scheduledActivity: pet.preferences.scheduledActivity, movement: pet.preferences.movement,
              ...(pet.preferences.x !== undefined && pet.preferences.y !== undefined ? { x: pet.preferences.x, y: pet.preferences.y } : {}) } });
        },
      });
      return new PetWorkspace({ ...workspaceOptions, catalog, importOne: packageImporter?.importOne.bind(packageImporter), lifecycle, stopAdditional: async () => {
        const status = player.snapshot().status;
        if (["unconfigured", "blocked", "stopped"].includes(status)) return true;
        return (await player.stop()).status === "stopped";
      } });
    })() : undefined;
    service = createService({
      token,
      workspace,
      player,
      runtime: new PythonRuntime({
        workerPath,
        guardianPath,
        python: python as string | undefined,
      }),
    });
    await service.listen({ host: "127.0.0.1", port: 0 });
    const address = service.server.address();
    if (!address || typeof address === "string")
      throw new Error("startup_failed");
    if (!stopping) send({ type: "ready", port: address.port });
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
