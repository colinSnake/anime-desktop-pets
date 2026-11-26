import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImagePreview } from '../src/ImagePreview.tsx';
import { imagePreviewSize, nextPreviewZoom } from '../src/image-preview-layout.ts';

test('fit preserves proportions, starts at no more than native size, and reports real pixel zoom', () => {
  assert.deepEqual(imagePreviewSize({ width: 1920, height: 1080 }, { width: 960, height: 800 }, 1), { width: 960, height: 540, percent: 50 });
  assert.deepEqual(imagePreviewSize({ width: 480, height: 960 }, { width: 960, height: 480 }, 2), { width: 480, height: 960, percent: 100 });
  assert.deepEqual(imagePreviewSize({ width: 240, height: 120 }, { width: 960, height: 480 }, 1), { width: 240, height: 120, percent: 100 });
  assert.equal(imagePreviewSize({ width: 0, height: 0 }, { width: 960, height: 480 }, 1), undefined);
  assert.equal(imagePreviewSize({ width: 1, height: 1 }, { width: 0, height: 480 }, 1), undefined);
});

test('zoom has bounded steps and returns to fit', () => {
  assert.equal(nextPreviewZoom(1, 1), 1.25);
  assert.equal(nextPreviewZoom(1, -1), 0.75);
  assert.equal(nextPreviewZoom(0.25, -1), 0.25);
  assert.equal(nextPreviewZoom(4, 1), 4);
  assert.equal(nextPreviewZoom(3, 0), 1);
});

test('the generic viewer has an accessible name and does not offer a download before an image is available', () => {
  const html = renderToStaticMarkup(createElement(ImagePreview, { src: '/fixtures/photo.webp', alt: '合成图片', downloadName: 'photo.webp', onDismiss() {} }));
  assert.match(html, /<dialog[^>]*aria-label="图片预览：合成图片"/);
  assert.match(html, /<img[^>]*src="\/fixtures\/photo.webp"[^>]*alt="合成图片"[^>]*draggable="false"/);
  for (const text of ['关闭预览', '放大图片', '缩小图片', '适合窗口']) assert.match(html, new RegExp(`aria-label="${text}"`));
  assert.doesNotMatch(html, /<a\b|download=/);
});
