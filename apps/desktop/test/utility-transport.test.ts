import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { UtilityProcess } from "electron";
import { utilityTransport } from "../src/utility-transport.ts";

test("queues bootstrap until the utility process has spawned and rejects sends after exit", () => {
  const child = new EventEmitter() as EventEmitter & {
    postMessage(value: unknown): void;
    pid?: number;
  };
  const received: unknown[] = [];
  child.postMessage = (value) => {
    received.push(value);
  };
  const transport = utilityTransport(child as unknown as UtilityProcess);
  transport.send({ type: "bootstrap" });
  assert.equal(received.length, 0);
  child.emit("spawn");
  assert.equal(received.length, 1);
  transport.send({ type: "shutdown" });
  assert.equal(received.length, 2);
  child.emit("exit", 0);
  assert.throws(() => transport.send({ type: "shutdown" }), /unavailable/);
  transport.terminate(); // 退出后不通过旧 PID 杀其他进程。
});
