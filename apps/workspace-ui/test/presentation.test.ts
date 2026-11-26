import { renderWorkspace } from './render-workspace.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';
import { PageLoadingSkeleton } from '../src/PageLoadingSkeleton.tsx';
import { PetWorkspaceController } from '../src/pet-state.ts';
import type { PetsBridge, WorkspaceData } from '../../../packages/contracts/src/pets.ts';

const diagnostics = { snapshot: undefined, error: '', busy: false, onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} };
const workspace: WorkspaceData = { revision: 0, theme: 'system', maximumRunning: 3, linkage: 'active',
  catalog: [], instances: [{ id: 'pet-one', package: { id: 'local.development.longmei', version: '0.0.0-dev' },
    enabled: true, autoStartOnLaunch: false, preferences: { size: 256, scheduledActivity: false, movement: false, hideInFullscreen: false }, phase: 'stopped' }] };

test('sidebar removes the slogan and theme selector while preserving navigation', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics }));
  assert.match(html, /工作区侧栏/);
  const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar); assert.doesNotMatch(sidebar, /让喜欢的角色，陪在桌边。|界面主题|workspace-theme|theme-toggle/);
});

test('lazy page fallbacks use an accessible skeleton instead of loading copy', async () => {
  const html = await renderWorkspace(createElement(PageLoadingSkeleton));
  assert.match(html, /class="page-loading-skeleton" role="status" aria-label="页面加载中" aria-busy="true"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /正在加载页面/);

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.equal((app.match(/<PageLoadingSkeleton \/>/g) ?? []).length, 2);
  assert.doesNotMatch(app, /正在加载页面/);

  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.page-loading-skeleton\s*\{/);
  assert.match(css, /@keyframes workspace-skeleton/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('workspace document uses only the product name, not the old title banner', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<title>桌边小崽<\/title>/);
});

test('every workspace page keeps its title and theme control without a breadcrumb', async () => {
  const pages = [
    ['pets', '桌宠'], ['chat', '聊天'], ['identity', '身份'], ['memory', '记忆'], ['goals', '能力与目标'],
    ['models', '模型管理'], ['speech', '语音互动'], ['live', '直播管理'], ['advanced', '高级'],
  ] as const;
  for (const [initialPage, label] of pages) {
    const html = await renderWorkspace(createElement(WorkspaceView, { ...diagnostics, initialPage }));
    assert.doesNotMatch(html, /workspace-breadcrumb|workspace-crumb-|aria-label="当前位置"/);
    assert.match(html, new RegExp(`<h1[^>]*>${label}</h1>`));
    assert.equal((html.match(/class="theme-toggle"/g) ?? []).length, 1);
    assert.match(html, /<main id="main"[^>]+tabindex="-1"/i);
    if (!['identity', 'memory', 'goals'].includes(initialPage)) {
      assert.match(html, new RegExp(`<button class="nav-item" aria-current="page">[\\s\\S]*?${label}</button>`));
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    }
  }
});

test('scrollbars are 4px both ways with rounded thumbs; sidebar stays scrollable without bars', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /(?<![\w.-])::?-webkit-scrollbar\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*(?:99|999)px/);
  assert.match(css, /\.sidebar\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.sidebar\s*\{[^}]*scrollbar-width:\s*none/);
  assert.match(css, /\.sidebar(?:::-webkit-scrollbar| nav::-webkit-scrollbar)[^{]*\{[^}]*display:\s*none/);
});

test('the development pet scene requests only a fixed same-origin cover, never a filesystem path', async () => {
  const controller = new PetWorkspaceController({ list: async () => ({ ok: true, workspace }) } as PetsBridge);
  await controller.load(); controller.edit({ displayName: '未保存名称' });
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: controller.getSnapshot(), petController: controller }));
  assert.match(html, /src="pet-app:\/\/workspace\/covers\/local\.development\.longmei\/0\.0\.0-dev\.png"/);
  assert.match(html, /封面暂不可用/);
  assert.doesNotMatch(html, /file:\/\/|\/Users\/|PET_PLAYER_ASSETS/);
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '未保存名称');
});
