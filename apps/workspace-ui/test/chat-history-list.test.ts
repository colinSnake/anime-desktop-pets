import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatHistoryDetail } from '../src/ChatHistoryDetail.tsx';
import { ChatHistoryList } from '../src/ChatHistoryList.tsx';

const rows = [
  { id: 'first', completedAt: 1795143600000, number: 14 },
  { id: 'second', completedAt: 1795140000000, number: 1 },
];
const render = (list = rows) => renderToStaticMarkup(createElement(ChatHistoryList, { rows: list, onRead() {} }));

test('each row is one button with a chat icon, stable number, time and trailing arrow, without message text', () => {
  const html = render();
  assert.match(html, /会话 14.*会话 01/s);
  const buttons = html.match(/<button\b[^>]*>.*?<\/button>/gs) ?? [];
  assert.equal(buttons.length, 2);
  for (const button of buttons) {
    assert.match(button, /<svg[^>]*aria-hidden="true"[^>]*>.*<strong>会话 \d+<\/strong>/s);
    assert.match(button, /<time datetime="[^"]+">[^<]+<\/time><svg[^>]*aria-hidden="true"/i);
  }
  assert.match(render(rows.slice().reverse()), /会话 01.*会话 14/s);
  assert.doesNotMatch(html, /纸飞机|很长的回复|晚安|第二条回复|aria-expanded=/);
});

test('history preview renders both exchanges and requires an explicit continue action', () => {
  const html = renderToStaticMarkup(createElement(ChatHistoryDetail, {
    entry: { session: rows[0]!, turns: [
      { requestID: 'one', completedAt: rows[1]!.completedAt, user: '纸飞机怎么折？', assistant: '合成回答' },
      { requestID: 'two', completedAt: rows[0]!.completedAt, user: '晚安', assistant: '第二条回复\n保留换行。' },
    ], hasEarlier: false }, name: '龙妹', onBack() {}, onContinue() {}, pending: false,
  }));
  assert.match(html, /<h1>会话 14<\/h1>/);
  assert.match(html, /纸飞机怎么折？.*合成回答.*晚安/s);
  assert.match(html, /<article[^>]*chat-message-assistant[^>]*>.*第二条回复\n保留换行。/s);
  assert.match(html, /返回历史<\/button>/);
  assert.match(html, /<button[^>]*class="button primary">继续聊天<\/button>/);
  assert.doesNotMatch(html, /contenteditable|发送消息|停止等待/);
});

test('a longer history preview offers a read-only pager without replacing Continue chatting', () => {
  const html = renderToStaticMarkup(createElement(ChatHistoryDetail, {
    entry: { session: rows[0]!, hasEarlier: true, turns: Array.from({ length: 6 }, (_, i) => ({
      requestID: crypto.randomUUID(), user: `合成第 ${i + 1} 问`, assistant: '合成回复', completedAt: rows[0]!.completedAt,
    })) }, name: '龙妹', onBack() {}, onContinue() {}, pending: false, readPage: async () => ({ ok: false, error: 'unavailable' } as const),
  }));
  assert.match(html, /aria-label="会话消息分页"/);
  assert.match(html, /<button[^>]*class="chat-control">更早消息<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>较新消息<\/button>/);
  assert.match(html, /继续聊天/);
  assert.doesNotMatch(html, /仅显示最近|contenteditable|发送消息/);
});
