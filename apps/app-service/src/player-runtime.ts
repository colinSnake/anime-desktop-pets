import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { BehaviorPreferences } from "../../../packages/contracts/src/pets.ts";
import type { PlayerController, PlayerSnapshot, PlayerInitialPreferences } from "../../../packages/contracts/src/index.ts";

/** Trusted Electron-main configuration, never accepted from HTTP / renderer. */
export type PlayerConfig = { source: string; assets: string; profileRoot: string };
export function validPlayerConfig(value: unknown): value is PlayerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return Object.keys(config).length === 3 && ["source", "assets", "profileRoot"].every(key =>
    typeof config[key] === "string" && config[key].length <= 1024 && !config[key].includes("\0") && isAbsolute(config[key]));
}
type Session = {
  child: ChildProcessWithoutNullStreams;
  credential: string;
  buffer: Buffer;
  exited: Promise<void>;
  done: boolean;
  invalid: boolean;
  cleanStopped?: boolean;
  cancelledId?: string;
  pending?: { id: string; phase: "running" | "stopped"; resolve(ok: boolean): void; reject(): void };
  disposing?: Promise<void>;
  onPosition?: (position: { x: number; y: number }) => void;
};
async function waitFor(promise: Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Owns only fresh private guardian/worker sessions; never adopts existing pets. */
export class PlayerRuntime implements PlayerController {
  private state: PlayerSnapshot;
  private session?: Session;
  private operation?: Promise<PlayerSnapshot>;
  private operationEpoch = 0;
  private launching?: Promise<PlayerSnapshot>;
  private cleanupFailed = false;
  private stopping?: Promise<PlayerSnapshot>;
  private closing?: Promise<void>;
  private closed = false;
  private epoch = 0;
  private onPosition?: (position: { x: number; y: number }) => void;
  constructor(private options: { guardianPath: string; workerPath: string; python?: string;
    config?: PlayerConfig; platform?: NodeJS.Platform; timeoutMs?: number;
    initialPreferences?: PlayerInitialPreferences;
    onPosition?: (position: { x: number; y: number }) => void }) {
    const status = !options.config ? "unconfigured" : !validPlayerConfig(options.config) ? "error" :
      (options.platform ?? process.platform) !== "darwin" ? "blocked" : "stopped";
    this.state = this.describe(status);
    this.onPosition = options.onPosition;
  }
  get pid() { return this.session?.child.pid; }
  snapshot(): PlayerSnapshot { return { ...this.state }; }
  private describe(status: PlayerSnapshot["status"]): PlayerSnapshot {
    const details = {
      unconfigured: "未配置开发播放器；不会自动启动或接管旧桌宠。",
      blocked: "既有播放器目前仅开放 macOS / Python 3.11+；Windows/Linux 解码与窗口适配尚未开放。",
      stopped: "开发播放器已停止；下次显式启动将使用全新隔离资料目录。",
      starting: "正在启动隔离的开发播放器，等待首个真实动画帧…",
      running: "开发播放器已显示首帧；账号、聊天、任务、语音和声音均未接入。",
      stopping: "正在等待播放器、解码线程和自有进程退出…",
      error: "开发播放器启动、运行或停止失败：请检查环境/协议；强制回收不等于正常清理确认，没有接管旧桌宠。",
    };
    return { kind: "qt-player", status, detail: details[status] };
  }
  start(preferences?: PlayerInitialPreferences): Promise<PlayerSnapshot> {
    if (this.closed || ["unconfigured", "blocked"].includes(this.state.status)) return Promise.resolve(this.snapshot());
    if (this.stopping) return this.stopping;
    if (this.operation && this.operationEpoch === this.epoch) return this.operation;
    if (this.state.status === "running") return Promise.resolve(this.snapshot());
    this.state = this.describe("starting");
    const epoch = ++this.epoch;
    this.cleanupFailed = false;
    this.operationEpoch = epoch;
    this.launching = this.launch(epoch, structuredClone(preferences ?? this.options.initialPreferences ?? { size: 256, hideInFullscreen: false, scheduledActivity: false, movement: true }));
    this.operation = this.launching.then(result => this.stopping ?? result).finally(() => {
      // A stop may resolve before this public promise's finalizer. Never let
      // the cancelled operation absorb or clear a subsequent explicit start.
      if (this.operationEpoch === epoch) {
        this.operation = undefined; this.launching = undefined;
      }
    });
    return this.operation;
  }
  private async launch(epoch: number, initial: PlayerInitialPreferences): Promise<PlayerSnapshot> {
    let session: Session | undefined;
    try {
      if (!validPlayerConfig(this.options.config) || !isAbsolute(this.options.workerPath) || !isAbsolute(this.options.guardianPath)) throw new Error();
      if (this.session) await this.dispose(this.session);
      if (epoch !== this.epoch) return this.snapshot();
      const config = this.options.config;
      await mkdir(config.profileRoot, { recursive: true, mode: 0o700 });
      const profile = await mkdtemp(join(config.profileRoot, "session-"));
      if (epoch !== this.epoch) return this.snapshot();
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"])
        if (process.env[key]) env[key] = process.env[key];
      for (const [key, subdir] of Object.entries({ HOME: "home", USERPROFILE: "home", XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", APPDATA: "config", LOCALAPPDATA: "cache", BAILONG_DATA_DIR: "data", CODEX_HOME: "disabled-codex" })) {
        env[key] = join(profile, subdir);
        await mkdir(env[key]!, { recursive: true, mode: 0o700 });
      }
      env.BAILONG_ASSETS_DIR = config.assets;
      if (epoch !== this.epoch) return this.snapshot();
      const child = spawn(this.options.python ?? (process.platform === "win32" ? "python" : "python3"),
        ["-I", "-B", "-u", this.options.guardianPath, this.options.workerPath, "--player"],
        { env, shell: false, windowsHide: true, stdio: "pipe" });
      let exited!: () => void;
      session = { child, credential: randomBytes(32).toString("hex"), buffer: Buffer.alloc(0),
        exited: new Promise(resolve => { exited = resolve; }), done: false, invalid: false,
        onPosition: this.onPosition };
      this.session = session;
      const owned = session;
      const fail = () => {
        owned.invalid = true; owned.buffer = Buffer.alloc(0); owned.pending?.reject();
        if (this.session === owned && epoch === this.epoch && !this.closed) this.state = this.describe("error");
        void this.dispose(owned).catch(() => { /* public state remains error */ });
      };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stderr.resume();
      child.on("close", () => {
        owned.done = true; exited();
        if (!owned.disposing && !owned.cleanStopped) fail();
        owned.pending?.reject();
      });
      child.stdout.on("data", (chunk: Buffer) => this.receive(owned, chunk, fail));
      if (!(await this.request(owned, "bootstrap", "running", { source: config.source, assets: config.assets, profile, preferences: initial }))) throw new Error();
      if (owned.done || owned.invalid || owned.disposing) throw new Error();
      if (epoch === this.epoch && !this.closed) this.state = this.describe("running");
    } catch {
      // A cancelling stop owns cleanup and waits for its distinct stopped ack.
      if (epoch === this.epoch) {
        if (session) await this.dispose(session);
        if (!this.closed) this.state = this.describe("error");
      }
    }
    return this.snapshot();
  }
  private receive(session: Session, chunk: Buffer, fail: () => void) {
    if (session.invalid || session.done || session.disposing) return;
    // Exactly one outstanding reply, at most 4096 bytes; no unbounded log stream.
    if (session.buffer.length + chunk.length > 4096) { fail(); return; }
    session.buffer = Buffer.concat([session.buffer, chunk]);
    let newline: number;
    while ((newline = session.buffer.indexOf(10)) >= 0) {
      const line = session.buffer.subarray(0, newline).toString("utf8");
      session.buffer = session.buffer.subarray(newline + 1);
      if (line === '{"version":3,"event":"stopped"}') {
        if (session.cleanStopped || session.buffer.length) { fail(); return; }
        session.cleanStopped = true;
        if (session.pending?.phase === "stopped") session.pending.resolve(true);
        else session.pending?.reject();
        void this.stop();
        return;
      }
      const event = this.parsePositionEvent(line);
      if (event === "invalid") { fail(); return; }
      if (event) {
        try { session.onPosition?.(event); } catch { /* persistence state is reported by the workspace */ }
        continue;
      }
      // A cancelled bootstrap can report ready/error before its queued stop is
      // processed. Accept exactly that one known ID, not arbitrary late replies.
      if (session.cancelledId && [true, false].some(ok => line === JSON.stringify({
        version: 3, id: session.cancelledId, ok, phase: ok ? "running" : "error",
      }))) { session.cancelledId = undefined; continue; }
      const pending = session.pending;
      if (!pending) { fail(); return; }
      const success = line === JSON.stringify({ version: 3, id: pending.id, ok: true, phase: pending.phase });
      const rejected = line === JSON.stringify({ version: 3, id: pending.id, ok: false, phase: "error" });
      if (!success && !rejected) { fail(); return; }
      if (success && pending.phase === "stopped") {
        if (session.buffer.length) { fail(); return; }
        session.cleanStopped = true;
      }
      pending.resolve(success);
    }
  }

  private parsePositionEvent(line: string): { x: number; y: number } | "invalid" | undefined {
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== "object" || Array.isArray(value) || !("event" in value)) return;
    const event = value as Record<string, unknown>;
    if (Object.keys(event).length !== 4 || event.version !== 3 || event.event !== "position" ||
        !Number.isSafeInteger(event.x) || !Number.isSafeInteger(event.y) ||
        Math.abs(event.x as number) > 1_000_000 || Math.abs(event.y as number) > 1_000_000) return "invalid";
    return { x: event.x as number, y: event.y as number };
  }

  setPositionListener(listener: (position: { x: number; y: number }) => void) {
    this.onPosition = listener;
    if (this.session) this.session.onPosition = listener;
  }

  private request(session: Session, command: "bootstrap" | "stop" | "apply" | "apply-behavior" | "show" | "hide", phase: "running" | "stopped",
    config?: { source: string; assets: string; profile: string; preferences: PlayerInitialPreferences },
    preferences?: { size: number; hideInFullscreen: boolean } | BehaviorPreferences) {
    return new Promise<boolean>((resolve, reject) => {
      const id = randomBytes(16).toString("hex");
      const timer = setTimeout(() => finish(false), command === "stop" ? 3000 : (this.options.timeoutMs ?? 8000));
      let finished = false;
      const finish = (ok: boolean) => {
        if (finished) return;
        finished = true; clearTimeout(timer); session.pending = undefined;
        ok ? resolve(true) : reject(new Error("player_unavailable"));
      };
      session.pending = { id, phase, resolve: ok => finish(ok), reject: () => finish(false) };
      const frame = JSON.stringify({ version: 3, session: session.credential, id, command, ...(config ? { config } : {}), ...(preferences ? { preferences } : {}) }) + "\n";
      if (session.done || session.invalid || Buffer.byteLength(frame) > 4096 || !session.child.stdin.writable) { finish(false); return; }
      session.child.stdin.write(frame, error => { if (error) finish(false); });
    });
  }
  applyDisplayPreferences(value: { size: number; hideInFullscreen: boolean }): Promise<boolean> {
    if (this.state.status !== "running" || !Number.isInteger(value.size) || value.size < 128 || value.size > 384 || typeof value.hideInFullscreen !== "boolean") return Promise.resolve(false);
    const session = this.session;
    if (!session || session.pending || session.invalid || session.done) return Promise.resolve(false);
    return this.request(session, "apply", "running", undefined, value).catch(() => false);
  }
  applyBehaviorPreferences(value: BehaviorPreferences): Promise<boolean> {
    if (this.state.status !== "running" || !value || Object.keys(value).length !== 2 || typeof value.scheduledActivity !== "boolean" || typeof value.movement !== "boolean") return Promise.resolve(false);
    const session = this.session;
    if (!session || session.pending || session.invalid || session.done) return Promise.resolve(false);
    return this.request(session, "apply-behavior", "running", undefined, { scheduledActivity: value.scheduledActivity, movement: value.movement }).catch(() => false);
  }
  setVisible(visible: boolean): Promise<boolean> {
    if (this.state.status !== "running" || typeof visible !== "boolean") return Promise.resolve(false);
    const session = this.session;
    if (!session || session.pending || session.invalid || session.done) return Promise.resolve(false);
    return this.request(session, visible ? "show" : "hide", "running").catch(() => false);
  }
  private dispose(session: Session): Promise<void> {
    if (session.disposing) return session.disposing;
    session.pending?.reject();
    session.disposing = (async () => {
      if (!session.done) {
        session.child.stdin.end();
        // Guardian's independent EOF budget includes genuine Qt teardown.
        if (!(await waitFor(session.exited, 4000))) {
          session.child.kill("SIGTERM");
          if (!(await waitFor(session.exited, 3500))) throw new Error("player_cleanup_timeout");
        }
      }
      if (this.session === session) this.session = undefined;
    })();
    return session.disposing;
  }
  stop(): Promise<PlayerSnapshot> {
    if (this.stopping) return this.stopping;
    if (["unconfigured", "blocked"].includes(this.state.status)) return Promise.resolve(this.snapshot());
    const session = this.session;
    const launching = this.launching;
    ++this.epoch;
    this.state = this.describe("stopping");
    this.stopping = (async () => {
      let confirmed = !session || session.cleanStopped === true;
      try {
        if (session && !session.done && !session.invalid && !session.disposing && !session.cleanStopped) {
          if (session.pending) {
            session.cancelledId = session.pending.id;
            session.pending.reject();
          }
          try { confirmed = await this.request(session, "stop", "stopped"); }
          catch { confirmed = Boolean(session.cleanStopped); }
        }
        if (session) await this.dispose(session);
        // Wait for path preparation or cancelled bootstrap, not the public
        // start promise (which itself waits for this complete stop result).
        await launching;
        if (!confirmed) this.cleanupFailed = true;
        this.state = this.describe(this.cleanupFailed ? "error" : "stopped");
      } catch { this.cleanupFailed = true; this.state = this.describe("error"); }
      return this.snapshot();
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.stop().then(result => { if (result.status === "error") throw new Error("player_cleanup_timeout"); });
    return this.closing;
  }
}
