/** 跨运行时公开契约：不包含端口、凭证、文件路径或任意命令。 */
export const PROTOCOL_VERSION = 1 as const;
export type PlatformCapabilities = {
  os: "macos" | "windows" | "linux" | "unsupported";
  session: "native" | "x11" | "wayland" | "unknown";
  desktopPet: "not-integrated";
  limitations: string[];
};
export type RuntimeSnapshot = {
  kind: "diagnostic";
  status: "idle" | "probing" | "ready" | "error" | "stopped";
  detail: string;
};
export interface RuntimeController {
  snapshot(): RuntimeSnapshot;
  probe(): Promise<RuntimeSnapshot>;
  close(): Promise<void>;
}
export type PlayerSnapshot = {
  kind: "qt-player";
  status: "unconfigured" | "blocked" | "stopped" | "starting" | "running" | "stopping" | "error";
  detail: string;
};
export type PlayerInitialPreferences = import("./pets.ts").PetPreferences;
export interface PlayerController {
  snapshot(): PlayerSnapshot;
  start(preferences?: PlayerInitialPreferences): Promise<PlayerSnapshot>;
  stop(): Promise<PlayerSnapshot>;
  applyDisplayPreferences(value: { size: number; hideInFullscreen: boolean }): Promise<boolean>;
  applyBehaviorPreferences(value: import("./pets.ts").BehaviorPreferences): Promise<boolean>;
  setVisible(visible: boolean): Promise<boolean>;
  setPositionListener?(listener: (position: { x: number; y: number }) => void): void;
  close(): Promise<void>;
}
export type Snapshot = {
  protocolVersion: typeof PROTOCOL_VERSION;
  product: "桌边小崽";
  stage: "foundation";
  service: { status: "ready" };
  platform: PlatformCapabilities;
  runtime: RuntimeSnapshot;
  player?: PlayerSnapshot;
};
export interface DesktopBridge {
  pets?: import("./pets.ts").PetsBridge;
  snapshot(): Promise<Snapshot>;
  probeRuntime(): Promise<Snapshot>;
  startPlayer(): Promise<Snapshot>;
  stopPlayer(): Promise<Snapshot>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
export function isSnapshot(value: unknown): value is Snapshot {
  if (
    !record(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.product !== "桌边小崽" ||
    value.stage !== "foundation"
  )
    return false;
  const { platform, runtime, service } = value;
  return (
    (value.player === undefined || isPlayerSnapshot(value.player)) &&
    record(service) &&
    service.status === "ready" &&
    record(platform) &&
    typeof platform.os === "string" &&
    ["macos", "windows", "linux", "unsupported"].includes(platform.os) &&
    typeof platform.session === "string" &&
    ["native", "x11", "wayland", "unknown"].includes(platform.session) &&
    platform.desktopPet === "not-integrated" &&
    Array.isArray(platform.limitations) &&
    platform.limitations.length <= 16 &&
    platform.limitations.every((item) => shortText(item, 512)) &&
    record(runtime) &&
    runtime.kind === "diagnostic" &&
    typeof runtime.status === "string" &&
    ["idle", "probing", "ready", "error", "stopped"].includes(runtime.status) &&
    shortText(runtime.detail, 2048)
  );
}

export function isPlayerSnapshot(value: unknown): value is PlayerSnapshot {
  return record(value) && Object.keys(value).length === 3 &&
    value.kind === "qt-player" && typeof value.status === "string" &&
    ["unconfigured", "blocked", "stopped", "starting", "running", "stopping", "error"].includes(value.status) &&
    shortText(value.detail, 2048);
}
