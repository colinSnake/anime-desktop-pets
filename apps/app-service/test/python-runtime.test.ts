import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PythonRuntime } from "../src/python-runtime.ts";

const guardianPath = resolve("apps/runtime-bridge/guardian.py");
const workerPath = resolve("apps/runtime-bridge/worker.py");
const python =
  process.env.PET_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("does not start before an explicit probe; uses a real worker and reaps it on close", async () => {
  const runtime = new PythonRuntime({ guardianPath, workerPath, python });
  assert.equal(runtime.snapshot().status, "idle");
  assert.equal(runtime.pid, undefined);
  try {
    assert.equal((await runtime.probe()).status, "ready");
    const pid = runtime.pid;
    assert.ok(pid && alive(pid));
    assert.equal((await runtime.probe()).status, "ready");
    assert.equal(runtime.pid, pid);
    await runtime.close();
    assert.equal(alive(pid), false);
    assert.equal(runtime.snapshot().status, "stopped");
    assert.equal((await runtime.probe()).status, "stopped");
  } finally {
    await runtime.close();
  }
});
test("concurrent probes share an operation; missing interpreter is a sanitized error", async () => {
  const runtime = new PythonRuntime({
    guardianPath,
    workerPath,
    python: join(tmpdir(), "pet-python-does-not-exist"),
  });
  const first = runtime.probe();
  assert.equal(runtime.probe(), first);
  assert.equal((await first).status, "error");
  assert.ok(!runtime.snapshot().detail.includes("pet-python-does-not-exist"));
  await runtime.close();
});
for (const mode of ["noisy", "wrong-id", "wrong-version", "exit", "hang"]) {
  test(`rejects ${mode} and actually reaps its child`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pet-runtime-test-"));
    const fixture = join(directory, `${mode}.py`);
    await copyFile(
      resolve("apps/app-service/test/fixtures/runtime-fixture.py"),
      fixture,
    );
    const runtime = new PythonRuntime({
      guardianPath,
      workerPath: fixture,
      python,
      timeoutMs: 150,
    });
    try {
      const pending = runtime.probe();
      const pid = runtime.pid;
      assert.equal((await pending).status, "error");
      if (pid) assert.equal(alive(pid), false);
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
test("closing while a probe is pending cancels it and prevents late success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pet-runtime-close-"));
  const fixture = join(directory, "hang.py");
  await copyFile(
    resolve("apps/app-service/test/fixtures/runtime-fixture.py"),
    fixture,
  );
  const runtime = new PythonRuntime({
    guardianPath,
    workerPath: fixture,
    python,
  });
  try {
    const pending = runtime.probe();
    const pid = runtime.pid;
    await runtime.close();
    assert.equal((await pending).status, "stopped");
    if (pid) assert.equal(alive(pid), false);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unexpected Python exit becomes error and a later probe starts a fresh worker", async () => {
  const runtime = new PythonRuntime({ guardianPath, workerPath, python });
  try {
    await runtime.probe();
    const first = runtime.pid;
    assert.ok(first);
    process.kill(first, "SIGTERM");
    const deadline = Date.now() + 2000;
    while (runtime.snapshot().status !== "error" && Date.now() < deadline)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    assert.equal(runtime.snapshot().status, "error");
    assert.equal((await runtime.probe()).status, "ready");
    assert.notEqual(runtime.pid, first);
  } finally {
    await runtime.close();
  }
});

test("does not inherit synthetic model credentials or Python import/startup hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pet-runtime-env-"));
  const fixture = join(directory, "env.py");
  await copyFile(
    resolve("apps/app-service/test/fixtures/runtime-fixture.py"),
    fixture,
  );
  const previous = Object.fromEntries(
    ["PET_MODEL_API_KEY", "PYTHONPATH", "PYTHONSTARTUP"].map((key) => [
      key,
      process.env[key],
    ]),
  );
  const runtime = new PythonRuntime({
    guardianPath,
    workerPath: fixture,
    python,
  });
  try {
    for (const key of Object.keys(previous))
      process.env[key] = "synthetic-private-value";
    assert.equal((await runtime.probe()).status, "ready");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("stdout remains bounded after a protocol fault while shutdown is pending", async () => {
  const runtime = new PythonRuntime({ guardianPath, workerPath, python });
  try {
    await runtime.probe();
    const session = (
      runtime as unknown as {
        session: {
          child: { stdout: { emit(event: string, value: Buffer): void } };
          buffer: Buffer;
        };
      }
    ).session;
    for (let i = 0; i < 32; i++)
      session.child.stdout.emit("data", Buffer.alloc(65536, 120));
    assert.ok(
      session.buffer.length <= 4096,
      `buffer retained ${session.buffer.length} bytes`,
    );
  } finally {
    await runtime.close();
  }
});
