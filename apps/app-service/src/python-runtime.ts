import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../../packages/contracts/src/index.ts";

type ChildSession = {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  buffer: Buffer;
  done: boolean;
  invalid?: boolean;
  pending?: { id: string; resolve(): void; reject(): void };
  stopping?: Promise<void>;
};
async function finishesWithin(
  promise: Promise<void>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 仅监督自己创建的诊断进程；不向 Python 传递宿主的模型密钥或 Python 注入环境。 */
export class PythonRuntime implements RuntimeController {
  private state: RuntimeSnapshot = {
    kind: "diagnostic",
    status: "idle",
    detail: "尚未探测；不会自动启动桌宠。",
  };
  private session?: ChildSession;
  private operation?: Promise<RuntimeSnapshot>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(
    private options: {
      workerPath: string;
      guardianPath: string;
      python?: string;
      timeoutMs?: number;
    },
  ) {}
  get pid() {
    return this.session?.child.pid;
  }
  snapshot(): RuntimeSnapshot {
    return { ...this.state };
  }

  probe(): Promise<RuntimeSnapshot> {
    if (this.closed) return Promise.resolve(this.snapshot());
    if (this.operation) return this.operation;
    this.state = {
      kind: "diagnostic",
      status: "probing",
      detail: "正在验证 Python 诊断协议…",
    };
    this.operation = this.runProbe().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }
  private async runProbe(): Promise<RuntimeSnapshot> {
    const session = this.session?.done
      ? this.start()
      : (this.session ?? this.start());
    try {
      await this.request(session);
      if (session.done || session.stopping) throw new Error("runtime_exited");
      if (!this.closed)
        this.state = {
          kind: "diagnostic",
          status: "ready",
          detail: "Python 诊断成功；尚未接入桌宠播放器和语音。",
        };
    } catch {
      await this.stop(session);
      if (this.session === session) this.session = undefined;
      if (!this.closed)
        this.state = {
          kind: "diagnostic",
          status: "error",
          detail: "Python 诊断失败：请检查解释器、协议或超时；未启动桌宠。",
        };
    }
    return this.snapshot();
  }
  private start(): ChildSession {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "TEMP",
      "TMP",
      "TMPDIR",
    ])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(
      this.options.python ??
        (process.platform === "win32" ? "python" : "python3"),
      ["-I", "-u", this.options.guardianPath, this.options.workerPath],
      { env, shell: false, windowsHide: true, stdio: "pipe" },
    );
    let exit!: () => void;
    const session: ChildSession = {
      child,
      exited: new Promise<void>((resolve) => {
        exit = resolve;
      }),
      buffer: Buffer.alloc(0),
      done: false,
    };
    this.session = session;
    const failed = () => {
      session.pending?.reject();
      if (!this.closed && this.session === session)
        this.state = {
          kind: "diagnostic",
          status: "error",
          detail: "Python 诊断进程已退出或协议无效。",
        };
    };
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stderr.resume(); // 持续排空，但不记录可能包含私有内容的 stderr。
    child.on("close", () => {
      session.done = true;
      failed();
      exit();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (session.invalid || session.stopping || session.done) return;
      if (session.buffer.length + chunk.length > 4096) {
        session.invalid = true;
        session.buffer = Buffer.alloc(0);
        failed();
        void this.stop(session).catch(() => failed());
        return;
      }
      session.buffer = Buffer.concat([session.buffer, chunk]);
      const newline = session.buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const reply: unknown = JSON.parse(
          session.buffer.subarray(0, newline).toString("utf8"),
        );
        session.buffer = session.buffer.subarray(newline + 1);
        const pending = session.pending;
        if (
          !pending ||
          session.buffer.length ||
          typeof reply !== "object" ||
          reply === null
        )
          throw new Error();
        const value = reply as Record<string, unknown>;
        if (
          value.version !== 1 ||
          value.id !== pending.id ||
          value.ok !== true ||
          value.kind !== "diagnostic"
        )
          throw new Error();
        session.pending = undefined;
        pending.resolve();
      } catch {
        session.invalid = true;
        session.buffer = Buffer.alloc(0);
        failed();
        void this.stop(session).catch(() => failed());
      }
    });
    return session;
  }
  private request(session: ChildSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending = undefined;
        reject(new Error("runtime_timeout"));
      }, this.options.timeoutMs ?? 2500);
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        session.pending = undefined;
        ok ? resolve() : reject(new Error("runtime_unavailable"));
      };
      const id = randomUUID();
      session.pending = {
        id,
        resolve: () => finish(true),
        reject: () => finish(false),
      };
      if (session.done || !session.child.stdin.writable) {
        finish(false);
        return;
      }
      session.child.stdin.write(
        JSON.stringify({ version: 1, id, command: "probe" }) + "\n",
        (error) => {
          if (error) finish(false);
        },
      );
    });
  }
  private stop(session: ChildSession): Promise<void> {
    if (session.stopping) return session.stopping;
    session.stopping = (async () => {
      session.pending?.reject();
      if (session.done) return;
      // EOF 由标准库 worker 正常处理；不发无 pending 的 shutdown 回复干扰协议。
      session.child.stdin.end();
      if (await finishesWithin(session.exited, 1500)) return;
      session.child.kill("SIGTERM");
      if (await finishesWithin(session.exited, 500)) return;
      session.child.kill("SIGKILL");
      if (!(await finishesWithin(session.exited, 1000)))
        throw new Error("runtime_cleanup_timeout");
    })();
    return session.stopping;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.state = {
      kind: "diagnostic",
      status: "stopped",
      detail: "诊断服务已停止。",
    };
    this.closing = (async () => {
      if (this.session) await this.stop(this.session);
      await this.operation;
      this.session = undefined;
    })();
    return this.closing;
  }
}
