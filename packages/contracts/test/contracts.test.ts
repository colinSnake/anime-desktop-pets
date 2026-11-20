import assert from "node:assert/strict";
import test from "node:test";
import { isSnapshot, PROTOCOL_VERSION } from "../src/index.ts";

const value = {
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
test("accepts a versioned foundation snapshot without claiming pet integration", () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(isSnapshot(value), true);
});
test("rejects malformed, future-version and misleading runtime states", () => {
  for (const invalid of [
    null,
    {},
    { ...value, protocolVersion: 2 },
    { ...value, runtime: { kind: "pet", status: "ready" } },
    { ...value, platform: { ...value.platform, os: "alien" } },
    { ...value, runtime: { ...value.runtime, detail: "x".repeat(2049) } },
  ])
    assert.equal(isSnapshot(invalid), false);
});

test("rejects arrays masquerading as scalar status and platform names", () => {
  assert.equal(
    isSnapshot({ ...value, runtime: { ...value.runtime, status: ["ready"] } }),
    false,
  );
  assert.equal(
    isSnapshot({ ...value, platform: { ...value.platform, os: ["linux"] } }),
    false,
  );
});

test("rejects the obsolete standalone Qt field even if no path or secret is present", () => {
  for (const player of [undefined, null, { kind: "qt-player", status: "running", detail: "首帧" }]) {
    assert.equal(isSnapshot({ ...value, player }), false);
  }
});
