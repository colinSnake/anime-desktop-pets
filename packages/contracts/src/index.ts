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
export type Snapshot = {
  protocolVersion: typeof PROTOCOL_VERSION;
  product: "桌边小崽";
  stage: "foundation";
  service: { status: "ready" };
  platform: PlatformCapabilities;
  runtime: RuntimeSnapshot;
};
export type WorkspaceFolderResult = "opened" | "not-ready" | "busy" | "unavailable";
export type WorkspaceMigrationResult = "not-needed" | "cancelled" | "busy" | "closing" | "unavailable";
export interface DesktopBridge {
  migrateWorkspaceData?(): Promise<WorkspaceMigrationResult>;
  openWorkspaceData?(): Promise<WorkspaceFolderResult>;
  legacyCharacterHandoff?: import("./legacy-character-snapshot.ts").LegacyHandoffBridge;
  characters?: import("./characters.ts").CharactersBridge;
  speech?: import("./speech.ts").SpeechBridge;
  chatHistory?: import("./chat-history.ts").ChatHistoryBridge;
  agentTasks?: import("./agent-tasks.ts").AgentTaskBridge;
  onlineChat?: import("./online-chat.ts").OnlineChatBridge;
  models?: import("./models.ts").ModelsBridge;
  pets?: import("./pets.ts").PetsBridge;
  snapshot(): Promise<Snapshot>;
  probeRuntime(): Promise<Snapshot>;
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
    !Object.hasOwn(value, "player") &&
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
