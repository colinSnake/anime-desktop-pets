import {
  isSnapshot,
  type DesktopBridge,
  type Snapshot,
} from "../../../packages/contracts/src/index.ts";

export async function loadSnapshot(
  bridge: DesktopBridge | undefined,
  command: "snapshot" | "probe" | "start-player" | "stop-player",
): Promise<Snapshot> {
  if (!bridge)
    throw new Error(
      "未连接桌面宿主。请通过 Electron 开发入口打开；浏览器预览不会伪造连接状态。",
    );
  let value: unknown;
  try {
    const actions = { snapshot: () => bridge.snapshot(), probe: () => bridge.probeRuntime(),
      "start-player": () => bridge.startPlayer(), "stop-player": () => bridge.stopPlayer() };
    value = await actions[command]();
  } catch {
    throw new Error("本地服务不可用，请关闭并重新打开开发工作区。");
  }
  if (!isSnapshot(value))
    throw new Error("本地服务协议不匹配，请重新构建工作区。");
  return value;
}
