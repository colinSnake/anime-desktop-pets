/** 包管理器和服务依赖边界回归，不启动桌面。 */
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import test from 'node:test';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
test('workspace uses pinned pnpm and no competing npm lockfile', async () => {
  const root = await json('package.json');
  assert.equal(root.packageManager, 'pnpm@10.32.0');
  assert.equal(root.workspaces, undefined);
  assert.equal(root.allowScripts, undefined);
  assert.ok(Object.values(root.scripts).every((command) => !/\bnpm\b/.test(command)));
  const workspace = await readFile('pnpm-workspace.yaml', 'utf8');
  assert.match(workspace, /onlyBuiltDependencies:/);
  assert.match(workspace, /esbuild/);
  await access('pnpm-lock.yaml');
  await assert.rejects(access('package-lock.json'), { code: 'ENOENT' });
});
test('desktop resolves the service through an explicit workspace dependency', async () => {
  const desktop = await json('apps/desktop/package.json');
  const service = await json('apps/app-service/package.json');
  assert.equal(desktop.dependencies?.['@pet/app-service'], 'workspace:*');
  assert.equal(service.exports, './dist/entry.cjs');
  assert.equal(service.dependencies?.fastify, '5.12.8');
  assert.equal(desktop.dependencies?.fastify, undefined);
});


test('only the local service directly pins the DeepSeek SDK and Provider plugin', async () => {
  const service = await json('apps/app-service/package.json');
  assert.equal(service.dependencies['@deepseek-ai/dsh'], undefined, 'the CLI is selected by the SDK, not by the service');
  for (const name of ['dsh-sdk-client', 'dsh', 'dsh-llm-pi-ai']) {
    const id = `@deepseek-ai/${name}`;
    if (name !== 'dsh') assert.equal(service.dependencies[id], '0.2.2-rc.5');
    for (const consumer of ['apps/desktop', 'apps/workspace-ui', 'packages/contracts']) {
      assert.equal((await json(`${consumer}/package.json`)).dependencies?.[id], undefined);
    }
  }
});
