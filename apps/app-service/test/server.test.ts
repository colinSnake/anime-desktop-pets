import assert from "node:assert/strict";
import test from "node:test";
import { createService } from "../src/server.ts";
import type {
  RuntimeController,
  RuntimeSnapshot,
} from "../../../packages/contracts/src/index.ts";

const token = "a".repeat(64);
function setup() {
  let calls = 0;
  let closed = false;
  const runtime: RuntimeController = {
    snapshot: (): RuntimeSnapshot => ({
      kind: "diagnostic",
      status: "idle",
      detail: "尚未探测",
    }),
    probe: async () => {
      calls++;
      return {
        kind: "diagnostic",
        status: "ready",
        detail: "诊断成功；非桌宠播放器",
      };
    },
    close: async () => {
      closed = true;
    },
  };
  return {
    app: createService({ token, runtime }),
    calls: () => calls,
    closed: () => closed,
  };
}
const headers = { host: "127.0.0.1", authorization: `Bearer ${token}` };
test("requires session authentication even for health; never emits credentials or CORS grants", async () => {
  const { app } = setup();
  try {
    for (const path of ["/v1/snapshot", "/health"]) {
      const response = await app.inject({
        url: path,
        headers: { host: "127.0.0.1" },
      });
      assert.equal(response.statusCode, 401);
      assert.ok(!response.body.includes(token));
    }
    const response = await app.inject({ url: "/v1/snapshot", headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().runtime.status, "idle");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
  }
});
test("rejects browser origins, DNS rebinding hosts, query parameters, arbitrary payloads and methods", async () => {
  const { app, calls } = setup();
  try {
    for (const origin of [
      "null",
      "https://attacker.invalid",
      "http://127.0.0.1",
    ])
      assert.equal(
        (
          await app.inject({
            url: "/v1/snapshot",
            headers: { ...headers, origin },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          url: "/v1/snapshot",
          headers: { ...headers, host: "attacker.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ url: "/v1/snapshot?token=secret", headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/v1/runtime/probe",
          method: "POST",
          headers,
          payload: { command: "exec" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await app.inject({ url: "/v1/snapshot", method: "DELETE", headers }))
        .statusCode,
      404,
    );
    assert.equal(calls(), 0);
  } finally {
    await app.close();
  }
});
test("probes only on explicit POST and closes its owned runtime", async () => {
  const { app, calls, closed } = setup();
  const response = await app.inject({
    url: "/v1/runtime/probe",
    method: "POST",
    headers,
    payload: {},
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().runtime.status, "ready");
  assert.equal(calls(), 1);
  await app.close();
  assert.equal(closed(), true);
});
test("binds a random loopback port and authenticates a real local request", async () => {
  const { app } = setup();
  try {
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${base}/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await app.close();
  }
});
test("runtime failures return sanitized errors rather than process output", async () => {
  const { app } = setup();
  await app.close();
  const broken = createService({
    token,
    runtime: {
      snapshot: () => ({ kind: "diagnostic", status: "error", detail: "失败" }),
      probe: async () => {
        throw new Error("private-payload");
      },
      close: async () => {},
    },
  });
  try {
    const response = await broken.inject({
      url: "/v1/runtime/probe",
      method: "POST",
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes("private-payload"));
  } finally {
    await broken.close();
  }
});

test("player routes accept only explicit empty actions, redact paths, and close with runtime", async () => {
  let starts = 0, stops = 0, closes = 0;
  const { app: unused } = setup(); await unused.close();
  const player = {
    snapshot: () => ({ kind: "qt-player" as const, status: "stopped" as const, detail: "隔离播放器" }),
    start: async () => { starts++; return { kind: "qt-player" as const, status: "running" as const, detail: "首帧" }; },
    stop: async () => { stops++; return player.snapshot(); },
    applyDisplayPreferences: async () => true, applyBehaviorPreferences: async () => true,
    setVisible: async () => true,
    close: async () => { closes++; },
  };
  const app = createService({ token, player, runtime: { snapshot: () => ({ kind: "diagnostic", status: "idle", detail: "诊断" }), probe: async () => ({ kind: "diagnostic", status: "ready", detail: "诊断" }), close: async () => {} } });
  try {
    assert.equal((await app.inject({ url: "/v1/snapshot", headers })).json().player.status, "stopped");
    for (const action of ["start", "stop"]) {
      for (const payload of [{ source: "/private" }, { command: "exec" }, [], null]) {
        assert.equal((await app.inject({ url: `/v1/player/${action}`, method: "POST", headers: { ...headers, "content-type": "application/json" }, payload: JSON.stringify(payload) })).statusCode, 400);
      }
      assert.equal((await app.inject({ url: `/v1/player/${action}`, method: "POST", headers: { ...headers, origin: "null" }, payload: {} })).statusCode, 403);
    }
    assert.equal(starts, 0); assert.equal(stops, 0);
    const started = await app.inject({ url: "/v1/player/start", method: "POST", headers, payload: {} });
    assert.equal(started.json().player.status, "running");
    await app.inject({ url: "/v1/player/stop", method: "POST", headers, payload: {} });
    assert.equal(starts, 1); assert.equal(stops, 1);
  } finally { await app.close(); }
  assert.equal(closes, 1);
});
