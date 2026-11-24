import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatModelMenu, ThinkingDepthSlider } from '../src/ChatModelPicker.tsx';
import { ModelReasoningField } from '../src/ModelConnectionEditor.tsx';
import { ModelWorkspaceController } from '../src/model-state.ts';
import type { ModelDraft } from '../../../packages/contracts/src/models.ts';

test('thinking slider exposes the Chinese level and keyboard-accessible discrete range', () => {
 const html = renderToStaticMarkup(createElement(ThinkingDepthSlider, { level: 'high', levels: ['low', 'medium', 'high', 'xhigh'], onChange() {} }));
 assert.match(html, /chat-thinking-heading[^>]*>高</);
 assert.match(html, /role="slider"/);
 assert.match(html, /aria-label="思考深度"/);
 assert.match(html, /aria-valuenow="2"/);
 assert.match(html, /aria-valuemax="3"/);
 assert.match(html, /aria-valuetext="高"/);
 assert.doesNotMatch(html, /NaN|Infinity/);
 const ordered = renderToStaticMarkup(createElement(ThinkingDepthSlider, { level: 'high', levels: ['low', 'medium', 'high'], onChange() {} }, createElement('button', { className: 'chat-thinking-model' }, '模型 ·')));
 assert.ok(ordered.indexOf('chat-thinking-heading') < ordered.indexOf('chat-thinking-model'));
 assert.ok(ordered.indexOf('chat-thinking-model') < ordered.indexOf('chat-thinking-slider'));
 const single = renderToStaticMarkup(createElement(ThinkingDepthSlider, { level: 'high', levels: ['high'], onChange() {} }));
 assert.doesNotMatch(single, /NaN|Infinity/);
});
test('thinking level and model share one hover group outside the slider', () => {
 const html = renderToStaticMarkup(createElement(ThinkingDepthSlider, { level: 'xhigh', levels: ['low', 'medium', 'high', 'xhigh'], onChange() {} }, createElement('button', { type: 'button', className: 'chat-thinking-model' }, '6.2 Sol')));
 assert.match(html, /<div class="chat-thinking-summary"><div class="chat-thinking-heading"[^>]*>极高<\/div><button[^>]*class="chat-thinking-model"[^>]*>6\.2 Sol<\/button><\/div><div class="chat-thinking-slider"/);
});
test('model menu groups providers, leaves rows model-only, and marks only the selection', () => {
 const models = [
  { id: 'one', name: 'deepseek-flash · DeepSeek', modelName: 'deepseek-flash', providerName: 'DeepSeek' },
  { id: 'two', name: 'gpt-6.2-sol · TIMICC', modelName: 'gpt-6.2-sol', providerName: 'TIMICC' },
 ];
 const html = renderToStaticMarkup(createElement(ChatModelMenu, { models, selectedId: 'two', online: true, onChoose() {} }));
 assert.match(html, /选择模型/);
 assert.match(html, /aria-label="DeepSeek"/);
 assert.match(html, /aria-label="TIMICC"/);
 assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1);
 assert.doesNotMatch(html, / · |使用全局默认|关闭模型选择/);
 const legacy = renderToStaticMarkup(createElement(ChatModelMenu, { models: [{ id: 'old', name: '旧模型 · 旧服务商' }], online: true, onChoose() {} }));
 assert.match(legacy, /aria-label="旧服务商"/);
 assert.match(legacy, />旧模型</);
 assert.doesNotMatch(legacy, /旧模型 · 旧服务商/);
});
test('model parameters show thinking depth default high and do not fabricate unsupported levels', () => {
 const entry = { entryID: 'entry', modelID: 'gpt-6.2-sol', displayName: '6.2 Sol', compatibility: {}, capabilities: { tools: { status: 'unknown' as const, source: 'user' as const } } };
 const connection: ModelDraft = { id: 'connection', displayName: 'TIMICC', preset: 'custom', apiProtocol: 'responses', baseURL: 'https://timicc.com/v1', authMode: 'none', models: [entry], compatibility: {}, defaultModelEntryID: entry.entryID };
 const controller = new ModelWorkspaceController();
 const render = (draft: ModelDraft, model = entry) => renderToStaticMarkup(createElement(ModelReasoningField, { connection: draft, entry: model, controller }));
 assert.match(render(connection), /思考深度/);
 assert.match(render(connection), /value="high" selected="">高</);
 assert.match(render(connection, { ...entry, reasoningEffort: 'low' } as typeof entry), /value="low" selected="">低</);
 assert.match(render({ ...connection, baseURL: 'https://example.invalid' }), /disabled=""/);
 assert.match(render({ ...connection, baseURL: 'https://example.invalid' }), /由模型自动决定/);
});
