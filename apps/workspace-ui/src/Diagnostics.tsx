import type { Snapshot } from "../../../packages/contracts/src/index.ts";
import type { LinkageState } from "../../../packages/contracts/src/pets.ts";
export type DiagnosticProps = {
  snapshot?: Snapshot;
  busy: boolean;
  error: string;
  onRefresh(): void;
  onProbe(): void;
  onStartPlayer(): void;
  onStopPlayer(): void;
  linkage?: LinkageState;
};
const platformNames = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  unsupported: "非目标系统",
};
const runtimeNames = {
  idle: "尚未探测",
  probing: "探测中",
  ready: "诊断通过",
  error: "诊断失败",
  stopped: "已停止",
};
export function DiagnosticsView({
  snapshot,
  busy,
  error,
  onRefresh,
  onProbe,
  onStartPlayer,
  onStopPlayer,
  linkage = "active",
}: DiagnosticProps) {
  return (
    <section className="diagnostics" aria-label="运行诊断">
        <header className="page-heading">
          <div>

            <h1>高级与运行诊断</h1>
            <p className="muted">TS / Python 跨平台迁移 · 运行概览</p>
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={onRefresh}
          >
            刷新状态
          </button>
        </header>
        <section className="notice" aria-label="迁移边界">
          <span className="notice-icon" aria-hidden="true">
            i
          </span>
          <div>
            <strong>新架构已起步，现有桌宠保持原样。</strong>
            <p>
              本页仅验证本地服务与 Python
              诊断协议，不控制真实桌宠、不读取已有记忆，也不调用在线模型。
            </p>
          </div>
        </section>
        <div className="feedback" aria-live="polite" aria-atomic="true">
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : busy ? (
            <p>正在获取本地状态…</p>
          ) : (
            <p>
              {snapshot
                ? "已连接本地工作区。诊断成功不代表完整桌宠已接入。"
                : "等待桌面宿主连接。"}
            </p>
          )}
        </div>
        <div className="status-grid">
          <section className="card">
            <div className="card-top">
              <span className="card-icon" aria-hidden="true">
                ◎
              </span>
              <span className="badge">应用服务</span>
            </div>
            <h2>{snapshot ? "本地服务已连接" : "尚未连接"}</h2>
            <p>Node.js / Fastify</p>
            <div className="card-bottom">回环监听 · 会话鉴权 · 受限桥接</div>
          </section>
          <section className="card">
            <div className="card-top">
              <span className="card-icon" aria-hidden="true">
                ⌘
              </span>
              <span className="badge">当前平台</span>
            </div>
            <h2>
              {snapshot ? platformNames[snapshot.platform.os] : "等待识别"}
            </h2>
            <p>
              {snapshot
                ? `会话：${snapshot.platform.session}`
                : "Windows / macOS / Linux"}
            </p>
            <div className="card-bottom">目标支持不等于各端实际验收</div>
          </section>
          <section className="card">
            <div className="card-top">
              <span className="card-icon" aria-hidden="true">
                ◇
              </span>
              <span className="badge">Python 桥接</span>
            </div>
            <h2>
              {snapshot ? runtimeNames[snapshot.runtime.status] : "尚未探测"}
            </h2>
            <p>{snapshot?.runtime.detail ?? "仅在点击后启动独立诊断进程。"}</p>
            <button
              className="button primary"
              disabled={busy || !snapshot}
              onClick={onProbe}
            >
              {busy ? "请稍候…" : "运行 Python 诊断"}
              <span aria-hidden="true"> ↗</span>
            </button>
          </section>
        </div>
        <section className="player-panel card" aria-label="开发播放器">
          <div className="section-heading">
            <div><h2>开发桌宠 · 显式启停</h2></div>
            <span className="badge">{({ unconfigured: "未配置", blocked: "平台未开放", stopped: "已停止", starting: "等待首帧", running: "运行中", stopping: "停止中", error: "启动/运行/停止失败" })[snapshot?.player?.status ?? "unconfigured"]}</span>
          </div>
          <p>{snapshot?.player?.detail ?? "未配置播放器；不会自动启动或接管旧桌宠。"}</p>
          <p>仅 macOS 开放既有播放器的开发接入；Windows/Linux 解码与窗口适配尚未开放。旧资料不迁移，模型、任务与语音尚未迁移。</p>
          <div className="player-actions">
            <button className="button primary" disabled={busy || linkage !== "active" || !snapshot?.player || !["stopped", "error"].includes(snapshot.player.status)} onClick={onStartPlayer}>启动开发桌宠</button>
            <button className="button" disabled={!snapshot?.player || !["starting", "running"].includes(snapshot.player.status)} onClick={onStopPlayer}>停止开发桌宠</button>
          </div>
        </section>
        <section className="platform-note">
          <h2>平台能力边界</h2>
          {snapshot ? (
            snapshot.platform.limitations.map((text) => (
              <p key={text}>{text}</p>
            ))
          ) : (
            <p>
              Linux 首版优先验证 X11/XWayland；原生 Wayland
              的全局定位、置顶和窗口跟随存在限制。
            </p>
          )}
        </section>
    </section>
  );
}
