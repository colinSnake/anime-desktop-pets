import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatReplySpeech, replySpeechText } from '../src/chat-reply-speech.ts';
import type { ReplySpeechCommand } from '../../../packages/contracts/src/speech.ts';

const id = '0f000000-0000-4000-8000-000000000011';
const reply = { ok: true, requestID: id, text: '你好，这是一条新的公开文字回复。', replayable: true } as const;

test('only the latest displayed new reply can use its receipt once; opt-out and expiry fail closed', async () => {
 let now = 0;
 const commands: ReplySpeechCommand[] = [];
 const speech = new ChatReplySpeech(async command => { commands.push(command); return true; }, () => now);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), false);
 speech.setEnabled(true);
 speech.receive(speech.begin(), { ...reply, recovered: true });
 assert.equal(speech.displayed(id), false);
 speech.receive(speech.begin(), { ...reply, replayable: false });
 assert.equal(speech.displayed(id), false);
 speech.receive(speech.begin(), { ...reply, historyStatus: 'omitted' });
 assert.equal(speech.displayed(id), false);
 speech.receive(speech.begin(), reply); now += 10_000;
 assert.equal(speech.displayed(id), false);
 const old = speech.begin(); const fresh = speech.begin(); speech.receive(old, reply);
 assert.equal(speech.displayed(id), false);
 speech.receive(fresh, reply);
 assert.equal(speech.displayed(crypto.randomUUID()), false);
 assert.equal(speech.displayed(id), true);
 assert.equal(speech.displayed(id), false);
 await speech.stop();
 assert.deepEqual(commands, [{ revision: 1, text: reply.text }, { revision: 2 }]);
});

test('plain reply excerpt is bounded and never speaks marked code, links or credential-like strings', () => {
 assert.equal(replySpeechText('  你好。\n\n 下一段。  '), '你好。 下一段。');
 for (const text of ['```js\na()\n```', '执行 `foo`', '[例子](https://work.invalid)', '跳转 https://work.invalid', 'api_key = sk-example1234567890', '<pre>content</pre>']) {
   assert.equal(replySpeechText(text), undefined, text);
 }
 const long = replySpeechText('春'.repeat(500))!;
 assert.ok([...long].length <= 120 && Buffer.byteLength(long) <= 512);
});

test('enabling playback does not admit a chat request started while it was disabled', () => {
 const speech = new ChatReplySpeech(async () => assert.fail('no playback'));
 const previous = speech.begin();
 speech.setEnabled(true);
 speech.receive(previous, reply);
 assert.equal(speech.displayed(id), false);
 const pending = speech.begin();
 speech.setEnabled(false);
 speech.setEnabled(true);
 speech.receive(pending, reply);
 assert.equal(speech.displayed(id), false);
});

test('a failed cancellation blocks playback until the next stop is confirmed', async () => {
 const commands: ReplySpeechCommand[] = [];
 let finishStop!: (ok: boolean) => void;
 const speech = new ChatReplySpeech(command => {
  commands.push(command);
  return command.revision === 2 ? new Promise(resolve => { finishStop = resolve; }) : Promise.resolve(true);
 });
 speech.setEnabled(true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 finishStop(false);
 await Promise.resolve();
 assert.equal(await speech.stop(), false);
 assert.deepEqual(commands, [{ revision: 1, text: reply.text }, { revision: 2 }]);
 assert.equal(await speech.stop(), true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 assert.deepEqual(commands.slice(2), [{ revision: 3 }, { revision: 4, text: reply.text }]);
 await speech.stop();
});

test('a receipt displayed after an unconfirmed stop cannot publish a new offer', async () => {
 const commands: ReplySpeechCommand[] = [];
 const speech = new ChatReplySpeech(async command => { commands.push(command); return command.revision !== 2; });
 speech.setEnabled(true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 const next = speech.begin();
 await new Promise(resolve => setImmediate(resolve));
 speech.receive(next, reply);
 assert.equal(speech.displayed(id), false);
 assert.deepEqual(commands, [{ revision: 1, text: reply.text }, { revision: 2 }]);
 await speech.stop();
});

test('a denied or revoked display acknowledgment cannot play after focus or microphone state changes', async () => {
 const commands: ReplySpeechCommand[] = [];
 let finishStop!: (ok: boolean) => void;
 const speech = new ChatReplySpeech(command => {
  commands.push(command);
  return command.revision === 2 ? new Promise(resolve => { finishStop = resolve; }) : Promise.resolve(true);
 });
 speech.setEnabled(true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id, () => false), false);
 assert.equal(speech.displayed(id), false, 'an acknowledgement denied during recording is consumed');
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 speech.receive(speech.begin(), reply);
 assert.equal(speech.displayed(id), true);
 const blurred = speech.stop();
 finishStop(true);
 assert.equal(await blurred, true);
 assert.deepEqual(commands, [{ revision: 1, text: reply.text }, { revision: 2 }]);
});
