import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InteractionToast } from '../src/pages/InteractionLayout.tsx';

test('interaction errors render as an accessible alert toast', () => {
  const html = renderToStaticMarkup(createElement(InteractionToast, { message: '暂时无法确认播报状态，请稍后重试。' }));
  assert.match(html, /class="interaction-toast"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /aria-live="assertive"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /暂时无法确认播报状态/);
});

test('interaction toast is fixed to the workspace window top and animates down without taking layout space', async () => {
  const css = await readFile(new URL('../src/pages/interaction-pages.css', import.meta.url), 'utf8');
  const toast = css.slice(css.indexOf('.interaction-toast {'), css.indexOf('\n}', css.indexOf('.interaction-toast {')) + 2);
  assert.match(toast, /position:\s*fixed/);
  assert.match(toast, /inset-block-start:\s*max\(12px,\s*env\(safe-area-inset-top\)\)/);
  assert.match(toast, /inset-inline-start:\s*50%/);
  assert.match(toast, /animation:\s*interaction-toast-enter/);
  assert.match(css, /@keyframes interaction-toast-enter\s*\{[^}]*translate:\s*0 -10px/);
});
