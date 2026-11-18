/** 只读预检；不创建 Qt 窗口，不启动/连接已有 helper。 */
import { safeQtReport } from './qt-preflight-report.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.PET_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const env = {};
for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY']) {
  if (process.env[key]) env[key] = process.env[key];
}
const result = spawnSync(python, ['-I', '-S', '-B', fileURLToPath(new URL('../apps/runtime-bridge/qt_preflight.py', import.meta.url)), '--repository', root], {
  cwd: root, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
});
const report = result.error || result.stderr ? undefined : safeQtReport(result.stdout, result.status);
if (!report) {
  console.error('Qt 启动前检查未完成；请检查 PET_PYTHON 或 Python 3 安装。未启动桌宠。');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = result.status;
}
