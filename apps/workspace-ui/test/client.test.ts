import { renderWorkspace } from './render-workspace.ts';
import assert from "node:assert/strict";
import { createElement } from "react";
import test from "node:test";
import { loadSnapshot } from "../src/client.ts";
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
test("advanced shows only diagnostic status and actions, not success detail or handoff controls", async () => {
  const html = await renderWorkspace(createElement(WorkspaceView, { initialPage: "advanced",
    snapshot: { ...snapshot, runtime: { kind: "diagnostic", status: "ready", detail: "Python 诊断成功；尚未接入桌宠播放器和语音。" } },
    busy: false, error: "", onRefresh() {}, onProbe() {},
  }));
  assert.match(html, /应用服务[\s\S]*本地服务已连接[\s\S]*当前平台[\s\S]*Linux[\s\S]*Python 桥接[\s\S]*诊断通过/);
  assert.match(html, /刷新状态[\s\S]*运行 Python 诊断/);
  assert.doesNotMatch(html, /尚未接入桌宠播放器|原生 Wayland 能力受限|刷新状态不会运行|旧角色资料交接|启动开发桌宠|停止开发桌宠|API Key/);
  assert.match(html, /aria-live="polite"/);
});

test("advanced preserves a failed probe's reason and disables actions during a request", async () => {
  const html = await renderWorkspace(createElement(WorkspaceView, { initialPage: "advanced",
    snapshot: { ...snapshot, runtime: { kind: "diagnostic", status: "error", detail: "诊断超时。" } },
    busy: true, error: "", onRefresh() {}, onProbe() {},
  }));
  assert.match(html, /诊断失败[\s\S]*诊断超时。/);
  const actions = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]);
  for (const label of ['刷新状态', '运行 Python 诊断'])
    assert.match(actions.find(button => button.includes(`<span>${label}</span>`)) ?? '', /disabled=""/);
});
