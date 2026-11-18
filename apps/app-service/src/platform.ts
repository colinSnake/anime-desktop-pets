import type { PlatformCapabilities } from "../../../packages/contracts/src/index.ts";

/** 会话信息只是能力提示，不把 DISPLAY 存在当作 XWayland 已验收。 */
export function platformCapabilities(
  platform: string,
  env: Record<string, string | undefined>,
): PlatformCapabilities {
  const os =
    platform === "darwin"
      ? "macos"
      : platform === "win32"
        ? "windows"
        : platform === "linux"
          ? "linux"
          : "unsupported";
  const session =
    os !== "linux"
      ? os === "unsupported"
        ? "unknown"
        : "native"
      : env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY
        ? "wayland"
        : env.XDG_SESSION_TYPE === "x11"
          ? "x11"
          : "unknown";
  const limitations = [
    "桌宠播放器、任务跟随和语音尚未接入跨平台宿主；本页只验证诊断协议。",
  ];
  if (os === "linux")
    limitations.push(
      session === "wayland"
        ? "原生 Wayland 的全局定位、置顶和窗口跟随受限；XWayland 需独立验证。"
        : "Linux 首版优先验证 X11/XWayland；当前会话提示不等于桌面验收。",
    );
  if (os === "unsupported") limitations.push("此操作系统不在首版目标范围内。");
  return { os, session, desktopPet: "not-integrated", limitations };
}
