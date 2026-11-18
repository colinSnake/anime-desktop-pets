import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BubbleSpeech, type SpeechTask } from '../src/speech/bubble-speech.ts';
import { readReferenceAudio } from '../src/speech/reference-audio.ts';
import { invalidCue, parseBubbleEvent } from '../src/speech/cue.ts';

function wav(seconds = 1) {
  const bytes = Buffer.alloc(44 + 32_000 * seconds);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24); bytes.writeUInt32LE(32_000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'pet-speech-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.wav'); await writeFile(path, wav()); return { path, dir };
}

test('reference selection reads bounded PCM from a regular file, rejects links, other formats and long audio', async t => {
  const { path, dir } = await fixture(t);
  assert.deepEqual(await readReferenceAudio(path), wav());
  const link = join(dir, 'link.wav'); await symlink(path, link);
  await assert.rejects(readReferenceAudio(link)); await assert.rejects(readReferenceAudio(dir));
  const long = join(dir, 'long.wav'); await writeFile(long, wav(31)); await assert.rejects(readReferenceAudio(long));
  const invalid = join(dir, 'invalid.wav'); const bytes = wav(); bytes.writeUInt16LE(3, 20);
  await writeFile(invalid, bytes); await assert.rejects(readReferenceAudio(invalid));
});

test('private speech events accept only canonical bounded cue frames and reject additional or repeated keys', () => {
  const frame = (text: string) => JSON.stringify({ version: 3, event: 'bubble-speech', text });
  assert.equal(parseBubbleEvent(frame('龙妹在这里。')), '龙妹在这里。');
  assert.equal(parseBubbleEvent(frame('字'.repeat(121))), invalidCue);
  assert.equal(parseBubbleEvent(frame('换\n行')), invalidCue);
  assert.equal(parseBubbleEvent('{"version":3,"event":"bubble-speech","text":"a","text":"b"}'), invalidCue);
  assert.equal(parseBubbleEvent('{"version":3,"event":"position","x":1,"y":2}'), undefined);
});

test('only valid owned cues play, pending latest wins, stop and pause invalidate old work', async t => {
  const { path } = await fixture(t);
  const runs: { task: SpeechTask; resolve: () => void }[] = [];
  const controller = new BubbleSpeech({ run: task => new Promise(resolve => { runs.push({ task, resolve }); }), close: async () => {} });
  let live = true;
  const a = Symbol(), b = Symbol();
  controller.offer(a, '没开机', () => true); assert.equal(runs.length, 0);
  assert.equal((await controller.select(path)).ok, true);
  assert.equal(controller.enable('参考文字').ok, true);
  controller.offer(a, '第一句', () => live);
  controller.offer(a, '过期的第二句', () => live);
  controller.offer(b, '第三句', () => true);
  assert.equal(runs.length, 1); assert.equal(runs[0]?.task.text, '第一句');
  runs[0]?.task.resolveStatus('speaking'); assert.equal(controller.status().state, 'speaking');
  live = false; const stopped = controller.cancelSource(a);
  assert.equal(runs[0]?.task.signal.aborted, true);
  runs[0]?.resolve(); await stopped; await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs[1]?.task.text, '第三句');
  await controller.pause(); assert.equal(runs[1]?.task.signal.aborted, true);
  runs[1]?.task.resolveStatus('speaking'); assert.equal(controller.status().state, 'enabled');
  runs[1]?.resolve(); await controller.close();
  controller.offer(b, '迟到', () => true); assert.equal(runs.length, 2);
});

test('failed reaping remains visible and blocks new speech until a retry confirms the stop', async t => {
  const { path } = await fixture(t);
  const source = Symbol();
  let finish!: () => void, signal!: AbortSignal, closeCalls = 0;
  const controller = new BubbleSpeech({
    run: task => new Promise(resolve => { finish = resolve; signal = task.signal; }),
    close: async () => { if (++closeCalls === 1) throw Error('synthetic cleanup failure'); },
  });
  assert.equal((await controller.select(path)).ok, true);
  assert.equal(controller.enable('合成逐字稿').ok, true);
  controller.offer(source, '当前气泡', () => true);
  const stopped = controller.cancelSource(source);
  assert.equal(signal.aborted, true);
  finish();
  await assert.rejects(stopped);
  assert.equal(controller.status().state, 'failed');
  assert.deepEqual(controller.enable('新的逐字稿'), { ok: false, error: 'busy' });
  await controller.cancelSource(source);
  assert.equal(closeCalls, 2);
  assert.equal(controller.status().state, 'disabled');
});

test('speech routes require authentication, validate exact inputs, and never return reference text or paths', async t => {
  const { path } = await fixture(t);
  const { createService } = await import('../src/server.ts');
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const controller = new BubbleSpeech({ run: async () => assert.fail('no player emitted a cue'), close: async () => {} });
  const token = 'd'.repeat(64);
  const app = createService({ token, speech: controller, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(() => app.close());
  const auth = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const request = (command: string, payload: object) => app.inject({ method: 'POST', url: `/v1/speech/bubbles/${command}`, headers: auth, payload });
  assert.equal((await app.inject({ url: '/v1/speech/bubbles', headers: { host: '127.0.0.1' } })).statusCode, 401);
  assert.equal((await request('reference', { path, extra: 'invalid' })).statusCode, 400);
  assert.deepEqual((await request('reference', { path })).json(), { ok: true, speech: { hasReference: true, state: 'disabled' } });
  assert.deepEqual((await request('enable', { referenceTranscript: '合成文本', text: 'arbitrary playback' })).json(), { ok: false, error: 'invalid' });
  assert.deepEqual((await request('enable', { referenceTranscript: '合成文本' })).json(), { ok: true, speech: { hasReference: true, state: 'enabled' } });
  assert.deepEqual((await request('clear-reference', {})).json(), { ok: false, error: 'busy' });
  assert.deepEqual((await request('disable', {})).json(), { ok: true, speech: { hasReference: true, state: 'disabled' } });
  assert.deepEqual((await request('clear-reference', {})).json(), { ok: true, speech: { hasReference: false, state: 'disabled' } });
});

test('real guardian and TTS wrapper reuse one fake local model/output, then reap a cancelled turn', { skip: process.platform === 'win32' }, async t => {
  const { dir } = await fixture(t);
  const { access, copyFile, readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  for (const name of ['stdio_service.py', 'protocol.py', 'session.py', 'queueing.py']) await copyFile(`apps/speech-runtime/${name}`, join(dir, name));
  await copyFile('apps/runtime-bridge/bubble_speech_worker.py', join(dir, 'bubble_speech_worker.py'));
  await writeFile(join(dir, 'mlx_backend.py'), `import asyncio, os, sys
from pathlib import Path
class LocalMLXBackend:
    sample_rate = 24000
    @classmethod
    def load(cls, model, asr):
        assert asr is None and os.environ['HF_HUB_OFFLINE'] == '1'
        assert 'synthetic-transcript' not in ' '.join(sys.argv)
        assert not (Path.cwd() / 'reference.txt').exists()
        assert os.environ['HOME'] == str(Path.cwd())
        with (model / 'worker-profiles').open('a') as f:
            f.write(str(Path.cwd()) + '\\n')
        return cls()
    async def synthesize(self, cue, path, transcript):
        assert cue in ('第一句', '第二句', '取消这句') and transcript == 'synthetic-transcript'
        assert path.read_bytes()[:4] == b'RIFF'
        yield b'\\x00\\x00' * 100
        if cue == '取消这句': await asyncio.sleep(30)
`);
  await writeFile(join(dir, 'sounddevice.py'), `def check_output_settings(**settings):
    assert settings['samplerate'] == 24000
class RawOutputStream:
    def __init__(self, **settings): assert settings['dtype'] == 'int16'
    def start(self): pass
    def write(self, data): assert data == b'\\x00\\x00' * 100
    def stop(self): pass
    def close(self): pass
    def abort(self): pass
`);
  const { LocalBubbleSpeechBackend } = await import('../src/speech/process-backend.ts');
  // Resolve before the worker intentionally receives an isolated PATH.
  const python = execFileSync(process.env.PET_PYTHON || 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const backend = new LocalBubbleSpeechBackend({ guardian: resolve('apps/runtime-bridge/guardian.py'), worker: join(dir, 'bubble_speech_worker.py'),
    model: dir, python }, 6000);
  t.after(() => backend.close());
  let started = 0;
  const abort = new AbortController();
  const run = (text: string, controller = abort, onStart = () => {}) => backend.run({ text, audio: wav(), transcript: 'synthetic-transcript', signal: controller.signal,
    resolveStatus: (state) => { assert.equal(state, 'speaking'); started++; onStart(); } });
  await run('第一句'); await run('第二句');
  const profiles = (await readFile(join(dir, 'worker-profiles'), 'utf8')).trim().split('\n');
  assert.equal(profiles.length, 1); assert.equal(started, 2);
  await assert.rejects(run('取消这句', abort, () => abort.abort()));
  assert.equal(started, 3);
  await assert.rejects(access(profiles[0]!));
});
