import assert from "node:assert/strict";
import test from "node:test";
import { platformCapabilities } from "../src/platform.ts";

test("distinguishes X11, XWayland target, native Wayland and unknown sessions without promising integration", () => {
  assert.equal(
    platformCapabilities("linux", { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" })
      .session,
    "x11",
  );
  assert.equal(
    platformCapabilities("linux", { WAYLAND_DISPLAY: "wayland-0" }).session,
    "wayland",
  );
  assert.equal(
    platformCapabilities("linux", {
      XDG_SESSION_TYPE: "wayland",
      DISPLAY: ":0",
    }).session,
    "wayland",
  );
  assert.equal(
    platformCapabilities("linux", { DISPLAY: ":0" }).session,
    "unknown",
  );
  assert.match(
    platformCapabilities("linux", {
      WAYLAND_DISPLAY: "wayland-0",
    }).limitations.join(" "),
    /Wayland/,
  );
  for (const os of ["darwin", "win32", "linux", "freebsd"])
    assert.equal(platformCapabilities(os, {}).desktopPet, "not-integrated");
  assert.equal(platformCapabilities("freebsd", {}).os, "unsupported");
});
