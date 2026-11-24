import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { VoiceDraftPicker, runVoiceTranscription } from '../src/voice-draft.ts';

const wav = () => {
  const b = Buffer.alloc(44 + 16000); // 1s, 8 kHz, mono, PCM16
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(16000, 40);
  return b;
};
const chosen = (path: string) => async () => ({ canceled: false, filePaths: [path] });

test('voice picker sends only validated audio bytes, never paths, and returns only text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-voice-test-'));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'input.wav'), link = join(dir, 'link.wav'), bad = join(dir, 'bad.wav');
  await writeFile(path, wav()); await symlink(path, link); await writeFile(bad, 'not WAV');
  let calls = 0;
  const picker = new VoiceDraftPicker(async (bytes, signal) => {
    calls++; assert.deepEqual(bytes, wav()); assert.equal(signal.aborted, false);
    return { ok: true, text: '合成转写' };
  });
  for (const candidate of [link, bad, dir]) assert.deepEqual(await picker.select(chosen(candidate), () => true), { ok: false, error: 'invalid-file' });
  assert.deepEqual(await picker.select(async () => ({ canceled: true, filePaths: [path] }), () => true), { ok: false, error: 'cancelled' });
  assert.deepEqual(await picker.select(chosen(path), () => true), { ok: true, text: '合成转写' });
  assert.equal(calls, 1);
});

test('cancelled selection never starts ASR or opens a second picker before the first settles', async () => {
  const picker = new VoiceDraftPicker(async () => { assert.fail('must not start'); });
  let resolve!: (value: { canceled: boolean; filePaths: string[] }) => void;
  const initial = picker.select(() => new Promise(done => { resolve = done; }), () => true);
  picker.cancel();
  assert.deepEqual(await picker.select(chosen('/not-a-real-file.wav'), () => true), { ok: false, error: 'busy' });
  resolve({ canceled: false, filePaths: ['/not-a-real-file.wav'] });
  assert.deepEqual(await initial, { ok: false, error: 'cancelled' });
});

test('real child: bounded stdin/stdout, cancellation and timeout settle after process close', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-voice-worker-'));
  t.after(() => rm(dir, { recursive: true }));
  const stub = join(dir, 'stub.cjs');
  async function worker(source: string, timeout = 1500, signal = new AbortController().signal) {
    await writeFile(stub, source);
    return runVoiceTranscription(process.execPath, [stub], wav(), signal, timeout);
  }
  assert.deepEqual(await worker(`let n=0;process.stdin.on('data',b=>n+=b.length);process.stdin.on('end',()=>console.log(JSON.stringify({text:n===16044?'合成转写':''})));`), { ok: true, text: '合成转写' });
  assert.deepEqual(await worker(`console.log(JSON.stringify({text:'',path:'/must-not-leak'}));`), { ok: false, error: 'failed' });
  assert.deepEqual(await worker(`console.log('x'.repeat(10000));`), { ok: false, error: 'failed' });
  assert.deepEqual(await worker(`setInterval(()=>{},1000);`, 35), { ok: false, error: 'timeout' });
  const abort = new AbortController();
  const pending = worker(`setInterval(()=>{},1000);`, 1500, abort.signal);
  setTimeout(() => abort.abort(), 35);
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
});

test('visibility cancellation revokes a late transcription and keeps the worker slot until cleanup', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-voice-visibility-'));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, 'input.wav'); await writeFile(path, wav());
  let finish!: () => void;
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>(done => { enter = done; });
  const picker = new VoiceDraftPicker(async (_bytes, signal) => {
    enter(signal); await new Promise<void>(done => { finish = done; });
    return { ok: true, text: '过时的文字' };
  });
  const pending = picker.select(chosen(path), () => true);
  const signal = await entered;
  const cleanup = picker.cancel();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await picker.select(chosen(path), () => true), { ok: false, error: 'busy' });
  finish();
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  await cleanup;
});

test('a stalled WAV read times out, permits a local retry, and never admits unbounded reads', async () => {
  const unblock: ((audio: Buffer) => void)[] = [];
  let transcriptions = 0;
  const picker = new VoiceDraftPicker(async () => { transcriptions++; return { ok: true, text: '正常转写' }; }, {
    readTimeoutMs: 25,
    readAudio: async path => path === '/ok.wav' ? wav() : new Promise(resolve => { unblock.push(resolve); }),
  });
  assert.deepEqual(await picker.select(chosen('/slow.wav'), () => true), { ok: false, error: 'timeout' });
  assert.deepEqual(await picker.select(chosen('/ok.wav'), () => true), { ok: true, text: '正常转写' });
  assert.deepEqual(await picker.select(chosen('/slow2.wav'), () => true), { ok: false, error: 'timeout' });
  assert.deepEqual(await picker.select(async () => { assert.fail('bounded read slots'); }, () => true), { ok: false, error: 'busy' });
  unblock.forEach(resolve => resolve(wav()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transcriptions, 1);
  assert.deepEqual(await picker.select(chosen('/ok.wav'), () => true), { ok: true, text: '正常转写' });
});

test('microphone and file transcriptions share a single slot even while cancellation drains', async () => {
  let finish!: () => void;
  let entered!: (signal: AbortSignal) => void;
  const worker = new Promise<AbortSignal>(done => { entered = done; });
  const picker = new VoiceDraftPicker(async (_audio, signal) => {
    entered(signal); await new Promise<void>(done => { finish = done; }); return { ok: true, text: '不应填入' };
  });
  const outer = new AbortController();
  const microphone = picker.record(wav(), outer.signal, () => true);
  const signal = await worker;
  const open = async () => ({ canceled: true, filePaths: [] });
  assert.deepEqual(await picker.select(open, () => true), { ok: false, error: 'busy' });
  outer.abort();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await picker.select(open, () => true), { ok: false, error: 'busy' });
  finish();
  assert.deepEqual(await microphone, { ok: false, error: 'cancelled' });
  const file = picker.select(open, () => true);
  assert.deepEqual(await picker.record(wav(), new AbortController().signal, () => true), { ok: false, error: 'busy' });
  assert.deepEqual(await file, { ok: false, error: 'cancelled' });
});
