import assert from "node:assert/strict";
import test from "node:test";
import {
  assetPath,
  trustedCaller,
  WORKSPACE_URL,
  WINDOW_SECURITY,
} from "../src/security.ts";

test("only the exact workspace main frame may use a no-argument bridge", () => {
  const frame = {};
  const other = {};
  assert.equal(
    trustedCaller({
      senderId: 1,
      ownerId: 1,
      senderFrame: frame,
      mainFrame: frame,
      url: WORKSPACE_URL,
      args: [],
    }),
    true,
  );
  for (const change of [
    { senderId: 2 },
    { senderFrame: other },
    { url: "https://attacker.invalid" },
    { url: `${WORKSPACE_URL}?x=1` },
    { args: ["exec"] },
    { senderFrame: null, mainFrame: null },
  ]) {
    assert.equal(
      trustedCaller({
        senderId: 1,
        ownerId: 1,
        senderFrame: frame,
        mainFrame: frame,
        url: WORKSPACE_URL,
        args: [],
        ...change,
      }),
      false,
    );
  }
  assert.deepEqual(WINDOW_SECURITY, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
});
test("custom protocol serves only bundled index and hashed JS/CSS assets", () => {
  assert.equal(assetPath(WORKSPACE_URL), "index.html");
  assert.equal(
    assetPath("pet-app://workspace/assets/index-abc.js"),
    "assets/index-abc.js",
  );
  for (const url of [
    "file:///etc/passwd",
    "pet-app://other/index.html",
    "pet-app://workspace/assets/../../secret",
    "pet-app://workspace/assets/%2e%2e%2fsecret.js",
    "pet-app://workspace/assets/x.py",
    `${WORKSPACE_URL}?x=1`,
    "not-a-url",
  ])
    assert.equal(assetPath(url), undefined);
});

test("workspace branding exposes the one shipped SVG and no other image path", () => {
  assert.equal(assetPath("pet-app://workspace/assets/app-icon.svg"), "assets/app-icon.svg");
  for (const path of ["assets/other.svg", "assets/app-icon.png", "branding/app-icon.svg",
    "assets/app-icon.svg?extra", "assets/app-icon.svg#extra", "assets/%61pp-icon.svg"])
    assert.equal(assetPath(`pet-app://workspace/${path}`), undefined, path);
});

test("same-document accessibility anchors do not disable the trusted main-frame bridge", () => {
  const frame = {};
  assert.equal(
    trustedCaller({
      senderId: 1,
      ownerId: 1,
      senderFrame: frame,
      mainFrame: frame,
      url: `${WORKSPACE_URL}#main`,
      args: [],
    }),
    true,
  );
});
