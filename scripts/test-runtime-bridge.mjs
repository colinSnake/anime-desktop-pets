import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const python =
  process.env.PET_PYTHON ||
  (process.platform === "win32" ? "python" : "python3");
const result = spawnSync(
  python,
  [
    "-I",
    "-m",
    "unittest",
    "discover",
    "-s",
    "apps/runtime-bridge",
    "-p",
    "test_*.py",
  ],
  { cwd: root, stdio: "inherit", shell: false },
);
if (result.error)
  console.error(
    "Python 诊断测试无法启动；请检查 PET_PYTHON 或 Python 3 安装。",
  );
process.exitCode = result.status ?? 1;
