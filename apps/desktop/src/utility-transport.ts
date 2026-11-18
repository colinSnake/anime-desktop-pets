import type { UtilityProcess } from "electron";
import type { ServiceTransport } from "./service-process.ts";

/** utility fork 的引导消息在 spawn 后发送；force 只针对当前自有子进程。 */
export function utilityTransport(child: UtilityProcess): ServiceTransport {
  let spawned = false;
  let exited = false;
  const pending: unknown[] = [];
  child.once("spawn", () => {
    spawned = true;
    for (const value of pending.splice(0)) child.postMessage(value);
  });
  child.once("exit", () => {
    exited = true;
    pending.length = 0;
  });
  return {
    send(value) {
      if (exited) throw new Error("service_unavailable");
      if (spawned) child.postMessage(value);
      else pending.push(value);
    },
    onMessage(handler) {
      child.on("message", handler);
    },
    onExit(handler) {
      child.once("exit", handler);
    },
    terminate() {
      if (!exited && child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
    },
  };
}
