import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { loadSnapshot } from "../src/client.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceView } from "../src/App.tsx";
import type { Snapshot } from "../../../packages/contracts/src/index.ts";

const snapshot: Snapshot = {
  protocolVersion: 1,
  product: "桌边小崽",
  stage: "foundation",
  service: { status: "ready" },
  platform: {
    os: "linux",
    session: "wayland",
    desktopPet: "not-integrated",
    limitations: ["原生 Wayland 能力受限"],
  },
  runtime: { kind: "diagnostic", status: "idle", detail: "尚未探测" },
};
test("browser-only preview cannot fake an Electron connection", async () => {
  await assert.rejects(loadSnapshot(undefined, "snapshot"), /桌面宿主/);
});
test("client validates snapshots and exposes only fixed commands", async () => {
  let probes = 0;
  const bridge = {
    snapshot: async () => snapshot,
    startPlayer: async () => snapshot,
    stopPlayer: async () => snapshot,
    probeRuntime: async () => {
      probes++;
      return snapshot;
    },
  };
  assert.equal((await loadSnapshot(bridge, "snapshot")).stage, "foundation");
  assert.equal(probes, 0);
  await loadSnapshot(bridge, "probe");
  assert.equal(probes, 1);
  await assert.rejects(
    loadSnapshot(
      { ...bridge, snapshot: async () => ({}) as Snapshot },
      "snapshot",
    ),
    /协议/,
  );
  await assert.rejects(
    loadSnapshot(
      {
        ...bridge,
        snapshot: async () => {
          throw new Error("sensitive-value");
        },
      },
      "snapshot",
    ),
    (error) => !String(error).includes("sensitive-value"),
  );
});
test("workspace states migration limits clearly and has no pretend product controls", () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceView, { initialPage: "advanced",
      snapshot,
      busy: false,
      error: "",
      onRefresh() {},
      onProbe() {},
      onStartPlayer() {},
      onStopPlayer() {},
    }),
  );
  assert.match(html, /桌边小崽/);
  assert.match(html, /尚未迁移/);
  assert.match(html, /Wayland/);
  assert.match(html, /诊断/);
  assert.ok(!html.includes("API Key"));
  assert.match(html, /aria-live="polite"/);
});

test("player commands are fixed and unconfigured/blocked controls cannot pretend to start", async () => {
  let starts = 0, stops = 0;
  const bridge = { snapshot: async () => snapshot, probeRuntime: async () => snapshot,
    startPlayer: async () => { starts++; return snapshot; }, stopPlayer: async () => { stops++; return snapshot; } };
  await loadSnapshot(bridge, "start-player"); await loadSnapshot(bridge, "stop-player");
  assert.equal(starts, 1); assert.equal(stops, 1);
  for (const status of ["unconfigured", "blocked"] as const) {
    const html = renderToStaticMarkup(createElement(WorkspaceView, { initialPage: "advanced", snapshot: { ...snapshot, player: { kind: "qt-player", status, detail: "未开放" } }, busy: false, error: "", onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} }));
    assert.match(html, /disabled=""[^>]*>启动开发桌宠/);
    assert.match(html, /disabled=""[^>]*>停止开发桌宠/);
  }
});
