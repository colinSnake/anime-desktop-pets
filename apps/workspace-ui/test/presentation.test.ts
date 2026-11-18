import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkspaceView } from '../src/App.tsx';
import { PetWorkspaceController } from '../src/pet-state.ts';
import type { PetsBridge, WorkspaceData } from '../../../packages/contracts/src/pets.ts';

const diagnostics = { snapshot: undefined, error: '', busy: false, onRefresh() {}, onProbe() {}, onStartPlayer() {}, onStopPlayer() {} };
const workspace: WorkspaceData = { revision: 0, theme: 'system', maximumRunning: 3, linkage: 'active',
  catalog: [], instances: [{ id: 'pet-one', package: { id: 'local.development.longmei', version: '0.0.0-dev' },
    enabled: true, autoStartOnLaunch: false, preferences: { size: 256, scheduledActivity: false, movement: false, hideInFullscreen: false }, phase: 'stopped' }] };

test('sidebar removes the slogan and theme selector while preserving navigation', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics }));
  assert.doesNotMatch(html, /让喜欢的角色，陪在桌边。/);
  assert.match(html, /工作区侧栏/);
  const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar); assert.doesNotMatch(sidebar, /界面主题|workspace-theme|theme-toggle/);
});

test('scrollbars are 4px both ways with rounded thumbs; sidebar stays scrollable without bars', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(css, /(?<![\w.-])::?-webkit-scrollbar\s*\{[^}]*width:\s*4px;[^}]*height:\s*4px;/);
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*(?:99|999)px/);
  assert.match(css, /\.sidebar\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.sidebar\s*\{[^}]*scrollbar-width:\s*none/);
  assert.match(css, /\.sidebar(?:::-webkit-scrollbar| nav::-webkit-scrollbar)[^{]*\{[^}]*display:\s*none/);
});

test('development pet cards request only a fixed same-origin cover, never a filesystem path', async () => {
  const controller = new PetWorkspaceController({ list: async () => ({ ok: true, workspace }) } as PetsBridge);
  await controller.load(); controller.edit({ displayName: '未保存名称' });
  const html = renderToStaticMarkup(createElement(WorkspaceView, { ...diagnostics, petState: controller.getSnapshot(), petController: controller }));
  assert.match(html, /src="pet-app:\/\/workspace\/covers\/local\.development\.longmei\/0\.0\.0-dev\.png"/);
  assert.match(html, /封面暂不可用/);
  assert.doesNotMatch(html, /file:\/\/|\/Users\/|PET_PLAYER_ASSETS/);
  assert.equal(controller.getSnapshot().drafts['pet-one']?.displayName, '未保存名称');
});
