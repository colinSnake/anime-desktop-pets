import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { liveActions, liveRoleActions } from '../../../packages/contracts/src/live-stage.ts';
import { stageVoiceDuration } from '../../../packages/contracts/src/live-voice.ts';
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
  assert.equal((await controller.enable('参考文字')).ok, true);
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

test('bubble lifetime tracks accepted work, queue replacement, drain, and playback failure', async t => {
  const { path } = await fixture(t);
  const reports: string[] = [];
  const tasks: SpeechTask[] = [], drain: (() => void)[] = [], fail: (() => void)[] = [];
  const controller = new BubbleSpeech({ run: task => new Promise<void>((resolve, reject) => {
    tasks.push(task); drain.push(resolve); fail.push(() => reject(new Error('fake device failed')));
  }), close: async () => {} });
  t.after(() => controller.close());
  const offer = (name: string, eligible = () => true) => controller.offer(Symbol(), '一条气泡', eligible, state => reports.push(`${name}:${state}`));
  assert.equal(offer('off'), false);
  await controller.select(path); await controller.enable('测试文本');
  assert.equal(offer('a'), true);
  assert.equal(offer('b'), true);
  assert.equal(offer('c'), true);
  tasks[0]!.resolveStatus('speaking');
  assert.deepEqual(reports, ['a:held', 'b:held', 'b:released', 'c:held']);
  drain[0]!(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(tasks.length, 2);
  assert.equal(offer('d'), true);
  fail[1]!(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reports.slice(4), ['a:drained', 'd:held', 'd:released', 'c:released']);
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
  assert.equal((await controller.enable('合成逐字稿')).ok, true);
  controller.offer(source, '当前气泡', () => true);
  const stopped = controller.cancelSource(source);
  assert.equal(signal.aborted, true);
  finish();
  await assert.rejects(stopped);
  assert.equal(controller.status().state, 'failed');
  assert.deepEqual(await controller.enable('新的逐字稿'), { ok: false, error: 'busy' });
  await controller.cancelSource(source);
  assert.equal(closeCalls, 2);
  assert.equal(controller.status().state, 'disabled');
});

test('speech routes require authentication, validate exact inputs, and never expose audio or source paths', async t => {
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
  assert.equal((await app.inject({ method: 'POST', url: '/v1/speech/bubbles/suspend', headers: { host: '127.0.0.1' }, payload: {} })).statusCode, 401);
  assert.equal((await request('reference', { path, extra: 'invalid' })).statusCode, 400);
  assert.deepEqual((await request('reference', { path })).json(), { ok: true, speech: { hasReference: true, state: 'disabled', previewAvailable: true } });
  assert.deepEqual((await request('transcript', { referenceTranscript: '合成文本' })).json(), { ok: true, speech: { hasReference: true, state: 'disabled', previewAvailable: true, referenceTranscript: '合成文本' } });
  assert.deepEqual((await request('transcript', { referenceTranscript: '\ud800' })).json(), { ok: false, error: 'invalid' });
  assert.deepEqual((await request('enable', { referenceTranscript: '合成文本', text: 'arbitrary playback' })).json(), { ok: false, error: 'invalid' });
  assert.deepEqual((await request('enable', { referenceTranscript: '合成文本', speakChatReplies: true })).json(), { ok: false, error: 'invalid' });
  assert.equal((await request('chat-reply', { revision: 1, text: '不应自动播报' })).statusCode, 404);
  assert.deepEqual((await request('enable', { referenceTranscript: '合成文本' })).json(), { ok: true, speech: { hasReference: true, state: 'enabled', previewAvailable: true, referenceTranscript: '合成文本' } });
  assert.equal((await request('suspend', { extra: true })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/speech/bubbles/suspend', headers: { host: '127.0.0.1', authorization: `Bearer ${token}` }, payload: {} })).statusCode, 200);
  assert.deepEqual((await request('resume', { preload: false, extra: true })).statusCode, 400);
  assert.equal((await request('resume', { preload: false })).json().speech.state, 'enabled');
  assert.deepEqual((await request('clear-reference', {})).json(), { ok: false, error: 'busy' });
  assert.deepEqual((await request('disable', {})).json(), { ok: true, speech: { hasReference: true, state: 'disabled', previewAvailable: true, referenceTranscript: '合成文本' } });
  assert.deepEqual((await request('clear-reference', {})).json(), { ok: true, speech: { hasReference: false, state: 'disabled', previewAvailable: true } });
});

test('real guardian and TTS wrapper reuse one fake local model/output, then reap a cancelled turn', { skip: process.platform === 'win32' }, async t => {
  const { dir, path } = await fixture(t);
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
        assert cue in ${JSON.stringify(['第一句','第二句','取消这句','临时生成的节目回应。',...Object.values(liveActions).map(action => action.line),...Object.values(liveRoleActions.dafeiyu).map(action => action.line)])} and transcript == 'synthetic-transcript'
        assert path.read_bytes()[:4] == b'RIFF'
        yield b'\\x00\\x00' * 100
        if cue == '取消这句': await asyncio.sleep(30)
`);
  await writeFile(join(dir, 'sounddevice.py'), `from pathlib import Path

def check_output_settings(**settings):
    assert settings['samplerate'] == 24000
class RawOutputStream:
    def __init__(self, **settings):
        assert settings['dtype'] == 'int16'
        Path(__file__).with_name('device-opened').touch()
    def start(self): pass
    def write(self, data): assert data == b'\\x00\\x00' * 100
    def stop(self, *, ignore_errors):
        assert not ignore_errors
        with Path(__file__).with_name('device-drains').open('a') as f:
            f.write('drained\\n')
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
  const controller = new BubbleSpeech(backend);
  assert.equal((await controller.select(path)).ok, true);
  assert.equal((await controller.enable('synthetic-transcript')).ok, true);
  const preloaded = async (count: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const profiles = await readFile(join(dir, 'worker-profiles'), 'utf8').catch(() => '');
      const paths = profiles.trim().split('\n').filter(Boolean);
      if (paths.length >= count) return paths[count - 1]!;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('explicit enable did not load a worker before the first cue');
  };
  const warmPath = await preloaded(1);
  const stage = await controller.prepareStageVoice(abort.signal, () => true);
  assert.ok(stage.ok);
  assert.deepEqual(Object.values(stage.clips).map(stageVoiceDuration),[5,5,5]);
  await assert.rejects(access(join(dir,'device-opened')));
  await assert.rejects(access(join(warmPath,'stage-01.wav')));
  assert.equal(await controller.prepareStageReply('<非法内容>',abort.signal,()=>true),undefined);
  const reply = await controller.prepareStageReply('临时生成的节目回应。',abort.signal,()=>true);
  assert.ok(reply); assert.equal(stageVoiceDuration(reply),5);
  await assert.rejects(access(join(warmPath,'stage-reply.wav')));
  const whale = await controller.prepareStageVoiceWithReference({ audio: wav(), transcript: 'synthetic-transcript' }, 'dafeiyu', abort.signal, () => true);
  assert.ok(whale.ok); assert.deepEqual(Object.values(whale.clips).map(stageVoiceDuration), [5,5,5]);
  await assert.rejects(access(join(warmPath,'stage-reply.wav')));

  await assert.rejects(access(join(dir, 'device-opened')));
  await run('第一句'); await run('第二句');
  assert.equal(await readFile(join(dir, 'device-drains'), 'utf8'), 'drained\ndrained\n');
  const profiles = (await readFile(join(dir, 'worker-profiles'), 'utf8')).trim().split('\n');
  assert.deepEqual(profiles, [warmPath]); assert.equal(started, 2);
  await assert.rejects(run('取消这句', abort, () => abort.abort()));
  assert.equal(started, 3);
  await assert.rejects(access(warmPath));
  assert.equal((await controller.disable()).ok, true);
  assert.equal((await controller.enable('synthetic-transcript')).ok, true);
  const nextWarmPath = await preloaded(2);
  await controller.pause(); // Reap a warmed worker even when it has no admitted cue.
  await assert.rejects(access(nextWarmPath));
  assert.equal(await readFile(join(dir, 'device-drains'), 'utf8'), 'drained\ndrained\n');
});

test('restart exposes TTS readiness and holds an early owned cue until worker ready', { skip: process.platform === 'win32' }, async t => {
  const { speech, dir, waitFor } = await restartWithControlledWorker(t);
  assert.equal(speech.status().state, 'enabled');
  assert.equal(speech.status().runtime, 'preparing');
  const { access, readFile } = await import('node:fs/promises');
  await waitFor(() => access(join(dir, 'booted')).then(() => true, () => false));
  const states: string[] = [];
  assert.equal(speech.offer(Symbol(), '重启后的第一条气泡', () => true, state => states.push(state)), true);
  assert.deepEqual(states, ['held']);
  assert.equal(speech.status().state, 'loading');
  await assert.rejects(access(join(dir, 'responded')));
  await writeFile(join(dir, 'release'), 'ready');
  await waitFor(() => states.length === 2);
  assert.deepEqual(states, ['held', 'drained']);
  assert.equal(await readFile(join(dir, 'responded'), 'utf8'), '1');
  assert.equal(speech.status().runtime, 'ready');
  await speech.pause();
  assert.equal(speech.status().runtime, 'cold');
});

test('startup preload failure is visible before a cue and retry does not erase the saved voice', { skip: process.platform === 'win32' }, async t => {
  const { speech, dir, waitFor } = await restartWithControlledWorker(t);
  await writeFile(join(dir, 'release'), 'error');
  await waitFor(() => speech.status().runtime === 'failed');
  assert.equal(speech.status().state, 'enabled');
  assert.equal(speech.status().hasReference, true);
  assert.equal(speech.status().referenceTranscript, '合成逐字稿');
  await writeFile(join(dir, 'release'), 'ready');
  assert.equal((await speech.preview({ revision: 1, play: true }, () => true)).ok, true);
  await waitFor(() => speech.status().state === 'enabled' && speech.status().runtime === 'ready');
});

test('a silent startup without ready leaves preparation with a failed status', { skip: process.platform === 'win32' }, async t => {
  const { speech, waitFor } = await restartWithControlledWorker(t, 600);
  await waitFor(() => speech.status().runtime === 'failed');
  assert.equal(speech.status().state, 'enabled');
});

test('cancelling a cold held cue never sends speech after a late ready', { skip: process.platform === 'win32' }, async t => {
  const { speech, dir, waitFor } = await restartWithControlledWorker(t);
  const { access } = await import('node:fs/promises');
  await waitFor(() => access(join(dir, 'booted')).then(() => true, () => false));
  const source = Symbol(), states: string[] = [];
  assert.equal(speech.offer(source, '取消冷启动气泡', () => true, state => states.push(state)), true);
  await speech.cancelSource(source);
  await writeFile(join(dir, 'release'), 'ready');
  assert.deepEqual(states, ['held', 'released']);
  await assert.rejects(access(join(dir, 'responded')));
  assert.equal(speech.status().runtime, 'cold');
});

async function restartWithControlledWorker(t: { after(callback: () => Promise<void>): void }, timeoutMs = 5_000) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'pet-speech-restart-'));
  const worker = join(dir, 'worker.py');
  await writeFile(worker, `import json, sys, time
from pathlib import Path
model = Path(json.loads(sys.stdin.readline())['model'])
(model / 'booted').touch()
release = model / 'release'
while not release.is_file(): time.sleep(0.01)
event = release.read_text()
print(event, flush=True)
if event == 'ready':
    for line in sys.stdin:
        assert json.loads(line)['speak'] is True
        with (model / 'responded').open('a') as f: f.write('1')
        print('audio-started', flush=True)
        print('idle', flush=True)
`);
  const { resolve } = await import('node:path');
  const { LocalBubbleSpeechBackend } = await import('../src/speech/process-backend.ts');
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const python = execFileSync(process.env.PET_PYTHON || 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
  const store = new SpeechProfileStore(join(dir, 'profile'));
  await store.write({ audio: wav(), transcript: '合成逐字稿', enabled: true });
  const backend = new LocalBubbleSpeechBackend({ python, guardian: resolve('apps/runtime-bridge/guardian.py'), worker, model: dir }, timeoutMs);
  const speech = new BubbleSpeech(backend, store);
  t.after(async () => { try { await speech.close(); } finally { await rm(dir, { recursive: true, force: true }); } });
  await speech.restoreProfile();
  return { speech, dir, async waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 3000;
    do {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 15));
    } while (Date.now() < deadline);
    assert.fail('speech state did not reach the expected condition');
  } };
}

test('local preview speaks only a fixed phrase after enable and never replaces other speech', async t => {
  const { path } = await fixture(t);
  const runs: SpeechTask[] = [];
  const controller = new BubbleSpeech({ run: task => new Promise<void>(resolve => {
    runs.push(task); task.signal.addEventListener('abort', () => resolve(), { once: true });
  }), close: async () => {} });
  t.after(() => controller.close());
  const preview = (revision: number, play = true, allowed = true) => controller.preview({ revision, play }, () => allowed);
  assert.deepEqual(await preview(1), { ok: false, error: 'reference-required' });
  await controller.select(path);
  await controller.enable('逐字稿不应作为试听正文');
  assert.deepEqual(await preview(2, true, false), { ok: false, error: 'busy' });
  assert.equal(runs.length, 0);
  assert.equal((await preview(3)).ok, true);
  assert.equal(runs[0]?.text, '你好，我是桌边小崽。这是本机语音试听，不会发送在线请求。');
  assert.equal(controller.status().previewing, true);
  assert.deepEqual(await preview(4), { ok: false, error: 'busy' });
  assert.equal(runs.length, 1);
  assert.equal((await preview(5, false)).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs[0]?.signal.aborted, true);
  assert.equal(controller.status().state, 'enabled');
  assert.equal(controller.status().previewing, undefined);
  assert.deepEqual(await preview(4), { ok: false, error: 'unavailable' });
  const bubble = Symbol();
  controller.offer(bubble, '正在播放的互动气泡', () => true);
  assert.deepEqual(await preview(6), { ok: false, error: 'busy' });
  assert.equal((await preview(7, false)).ok, true);
  assert.equal(runs[1]?.signal.aborted, false);
});

test('a higher preview stop fences a delayed play and pause prevents later admission', async t => {
  const { path } = await fixture(t);
  const controller = new BubbleSpeech({ run: async () => assert.fail('no preview admitted'), close: async () => {} });
  t.after(() => controller.close());
  await controller.select(path); await controller.enable('合成逐字稿');
  assert.equal((await controller.preview({ revision: 2, play: false }, () => false)).ok, true);
  assert.deepEqual(await controller.preview({ revision: 1, play: true }, () => true), { ok: false, error: 'unavailable' });
  await controller.disable();
  assert.deepEqual(await controller.preview({ revision: 3, play: true }, () => true), { ok: false, error: 'reference-required' });
});

test('local preview route is authenticated, exact-shape and pause-gated', async t => {
  const { path } = await fixture(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-preview-workspace-'));
  const { createService } = await import('../src/server.ts');
  const { PetWorkspace } = await import('../src/pet-workspace.ts');
  const runs: SpeechTask[] = [];
  const speech = new BubbleSpeech({ run: task => new Promise<void>(resolve => {
    runs.push(task); task.signal.addEventListener('abort', () => resolve(), { once: true });
  }), close: async () => {} });
  const workspace = new PetWorkspace({ root, catalog: [], onPauseRequested: () => { void speech.pause(); } });
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const token = 'f'.repeat(64), url = '/v1/speech/bubbles/preview';
  const app = createService({ token, workspace, speech, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { try { await app.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const request = (payload: object) => app.inject({ method: 'POST', url, headers, payload });
  assert.equal((await app.inject({ method: 'POST', url, headers: { host: headers.host }, payload: { revision: 1, play: true } })).statusCode, 401);
  for (const payload of [{}, { revision: 0, play: true }, { revision: 1.5, play: true }, { revision: Number.MAX_SAFE_INTEGER + 1, play: true },
    { revision: 1, play: 'true' }, { revision: 1, play: true, text: 'do not speak arbitrary input' }, { revision: 1, play: true, path }]) {
    assert.equal((await request(payload)).statusCode, 400);
  }
  assert.equal(runs.length, 0);
  await workspace.list(); await speech.select(path); await speech.enable('合成音色逐字稿');
  assert.equal((await request({ revision: 1, play: true })).json().ok, true);
  assert.equal(runs.length, 1);
  assert.equal((await request({ revision: 2, play: false })).json().ok, true);
  assert.equal(runs[0]?.signal.aborted, true);
  assert.equal((await workspace.mutate('pause', { expectedRevision: 0 })).ok, true);
  assert.deepEqual((await request({ revision: 3, play: true })).json(), { ok: false, error: 'busy' });
  assert.equal(runs.length, 1);
});

test('release after local transcription clears suspension without preloading when globally paused', async t => {
  const { path } = await fixture(t);
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pet-speech-pause-'));
  const { createService } = await import('../src/server.ts');
  const { PetWorkspace } = await import('../src/pet-workspace.ts');
  let prepares = 0;
  const speech = new BubbleSpeech({ prepare: () => { prepares++; }, close: async () => {}, run: async () => {} });
  const workspace = new PetWorkspace({ root, catalog: [], stopAdditional: async () => { await speech.pause(); return true; } });
  const snapshot = () => ({ kind: 'diagnostic', status: 'idle', detail: '' } as const);
  const token = 'f'.repeat(64);
  const app = createService({ token, workspace, speech, runtime: { snapshot, probe: async () => snapshot(), close: async () => {} } });
  t.after(async () => { try { await app.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  const headers = { host: '127.0.0.1', authorization: `Bearer ${token}` };
  const request = (command: string, payload: object) => app.inject({ method: 'POST', url: `/v1/speech/bubbles/${command}`, headers, payload });
  const initial = await workspace.list();
  assert.equal(initial.ok, true);
  if (!initial.ok) assert.fail('workspace unavailable');
  const expectedRevision = initial.workspace.revision;
  await speech.select(path);
  await speech.enable('合成逐字稿');
  assert.equal((await request('suspend', {})).json().ok, true);
  assert.equal((await workspace.mutate('pause', { expectedRevision })).ok, true);
  assert.equal((await request('resume', { preload: true })).json().ok, true);
  assert.equal(prepares, 1);
  assert.equal((await workspace.mutate('resume', { expectedRevision })).ok, true);
  assert.equal((await request('preview', { revision: 1, play: true })).json().ok, true);
});

test('speech profile restores audio and an unenabled transcript draft without enabling playback', async t => {
  const { path, dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const { stat } = await import('node:fs/promises');
  const profileRoot = join(await realpath(dir), 'speech');
  const tasks: SpeechTask[] = [];
  const open = async () => {
    const speech = new BubbleSpeech({ run: async task => { tasks.push(task); }, close: async () => {} }, new SpeechProfileStore(profileRoot));
    await speech.restoreProfile();
    return speech;
  };
  const first = await open();
  assert.equal((await first.select(path)).ok, true);
  assert.equal((await first.saveTranscriptDraft('未启用的合成逐字稿')).ok, true);
  await first.close();
  await rm(path);
  assert.equal((await stat(profileRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(join(profileRoot, 'reference-profile.json'))).mode & 0o777, 0o600);
  const restored = await open();
  assert.deepEqual(restored.status(), { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '未启用的合成逐字稿' });
  assert.equal(tasks.length, 0);
  assert.deepEqual(await restored.preview({ revision: 1, play: true }, () => true), { ok: false, error: 'reference-required' });
  assert.equal((await restored.enable('未启用的合成逐字稿')).ok, true);
  assert.equal((await restored.preview({ revision: 2, play: true }, () => true)).ok, true);
  assert.deepEqual(tasks.map(task => [task.audio, task.transcript]), [[wav(), '未启用的合成逐字稿']]);
  await restored.disable();
  await restored.close();
  const disabledAgain = await open();
  assert.deepEqual(disabledAgain.status(), { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '未启用的合成逐字稿' });
  assert.equal((await disabledAgain.clearReference()).ok, true);
  await disabledAgain.close();
  const cleared = await open();
  assert.equal(cleared.status().hasReference, false);
  assert.equal(cleared.status().referenceTranscript, undefined);
  await cleared.close();
});

test('speech explicitly enabled before shutdown is enabled again after restart without spontaneous playback', async t => {
  const { path, dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const profileRoot = join(await realpath(dir), 'speech');
  const tasks: SpeechTask[] = [];
  const prepared: string[] = [];
  const open = async () => {
    const speech = new BubbleSpeech({ run: async task => { tasks.push(task); }, prepare: profile => { prepared.push(profile.transcript); }, close: async () => {} }, new SpeechProfileStore(profileRoot));
    await speech.restoreProfile();
    return speech;
  };
  const first = await open();
  assert.equal((await first.select(path)).ok, true);
  assert.equal((await first.saveTranscriptDraft('已启用的合成逐字稿')).ok, true);
  assert.equal((await first.enable('已启用的合成逐字稿')).ok, true);
  await first.close();
  prepared.length = 0;

  const restored = await open();
  assert.deepEqual(restored.status(), { state: 'enabled', previewAvailable: true, hasReference: true, referenceTranscript: '已启用的合成逐字稿' });
  assert.equal(tasks.length, 0);
  assert.deepEqual(prepared, ['已启用的合成逐字稿']);
  assert.equal((await restored.preview({ revision: 1, play: true }, () => true)).ok, true);
  assert.deepEqual(tasks.map(task => [task.audio, task.transcript]), [[wav(), '已启用的合成逐字稿']]);
  assert.deepEqual(await restored.disable(), { ok: true, speech: { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '已启用的合成逐字稿' } });
  await restored.close();
  const disabled = await open();
  assert.equal(disabled.status().state, 'disabled');
  assert.equal(disabled.status().hasReference, true);
  await disabled.close();
});

test('schema version 1 speech profiles restore safely as disabled', async t => {
  const { dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const { mkdir } = await import('node:fs/promises');
  const profileRoot = join(await realpath(dir), 'speech');
  await mkdir(profileRoot, { mode: 0o700 });
  await writeFile(join(profileRoot, 'reference-profile.json'), JSON.stringify({ schemaVersion: 1, wav: wav().toString('base64'), transcript: '旧版已保存逐字稿' }), { mode: 0o600 });
  const speech = new BubbleSpeech({ run: async () => assert.fail('no playback'), prepare: () => assert.fail('legacy profiles must not auto-enable'), close: async () => {} }, new SpeechProfileStore(profileRoot));
  await speech.restoreProfile();
  assert.deepEqual(speech.status(), { state: 'disabled', previewAvailable: true, hasReference: true, referenceTranscript: '旧版已保存逐字稿' });
  await speech.close();
});

test('unreadable speech profile degrades only speech and does not replace the suspect file', async t => {
  const { path, dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const { mkdir, readFile } = await import('node:fs/promises');
  const root = join(await realpath(dir), 'speech');
  await mkdir(root, { mode: 0o700 });
  const suspect = join(root, 'reference-profile.json');
  await symlink(path, suspect);
  const speech = new BubbleSpeech({ run: async () => assert.fail('no playback'), close: async () => {} }, new SpeechProfileStore(root));
  await speech.restoreProfile();
  assert.equal(speech.status().state, 'unavailable');
  assert.equal(speech.status().storageUnavailable, true);
  assert.deepEqual(await speech.select(path), { ok: false, error: 'storage' });
  assert.deepEqual(await speech.clearReference(), { ok: false, error: 'storage' });
  assert.deepEqual(await readFile(path), wav());
  await speech.close();
});

test('closing speech drains an admitted profile write and does not publish a new session', async t => {
  const { path, dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const { setImmediate: turn } = await import('node:timers/promises');
  const profile = new SpeechProfileStore(join(await realpath(dir), 'speech'));
  const write = profile.write.bind(profile);
  const controller = new BubbleSpeech({ run: async () => assert.fail('no playback'), close: async () => {} }, profile);
  await controller.restoreProfile();
  assert.equal((await controller.select(path)).ok, true);
  let allow!: () => void;
  const wait = new Promise<void>(resolve => { allow = resolve; });
  profile.write = async data => { await wait; return write(data); };
  const enabling = controller.enable('在途合成逐字稿');
  let closed = false;
  const closing = controller.close().then(() => { closed = true; });
  try { await turn(); assert.equal(closed, false); }
  finally { allow(); await closing; await enabling; }
  assert.deepEqual(await enabling, { ok: false, error: 'unavailable' });
  assert.equal((await profile.read())?.transcript, '在途合成逐字稿');
});

test('voice-draft suspension closes TTS without changing the saved enable preference and rewarms on resume', async t => {
  const { path, dir } = await fixture(t);
  const { SpeechProfileStore } = await import('../src/speech/profile-store.ts');
  const profile = new SpeechProfileStore(join(await realpath(dir), 'speech'));
  const tasks: SpeechTask[] = [];
  let prepares = 0, closes = 0;
  const speech = new BubbleSpeech({
    prepare: () => { prepares++; },
    run: task => new Promise<void>(resolve => {
      tasks.push(task);
      task.signal.addEventListener('abort', () => resolve(), { once: true });
    }),
    close: async () => { closes++; },
  }, profile);
  t.after(() => speech.close());
  assert.deepEqual(await speech.select(path), { ok: true, speech: { state: 'disabled', hasReference: true, previewAvailable: true } });
  assert.equal((await speech.enable('已保存参考稿')).ok, true);
  assert.equal(prepares, 1);
  assert.equal(speech.offer(Symbol(), '正在播报的一句', () => true), true);
  assert.equal(tasks.length, 1);

  const suspend = (speech as unknown as { suspendForVoiceDraft?: () => Promise<{ ok: boolean }> }).suspendForVoiceDraft;
  assert.equal(typeof suspend, 'function', 'recording must be able to suspend the active TTS worker');
  assert.equal((await suspend!.call(speech)).ok, true);
  assert.equal(tasks[0]?.signal.aborted, true);
  assert.equal(closes, 1);
  assert.equal((await profile.read())?.enabled, true, 'temporary suspension must not persist as a user disable');
  assert.equal(speech.offer(Symbol(), '录音时到达的旧 cue', () => true), false);

  const resume = (speech as unknown as { resumeAfterVoiceDraft?: (preload: boolean) => { ok: boolean } }).resumeAfterVoiceDraft;
  assert.equal(typeof resume, 'function');
  assert.equal(resume!.call(speech, true).ok, true);
  assert.equal(prepares, 2, 'an enabled, visible session should be warmed again after ASR releases the model');
  assert.equal(speech.status().state, 'enabled');
  assert.equal(speech.offer(Symbol(), '恢复后的 cue', () => true), true);
  assert.equal(tasks.length, 2);
  await speech.pause();
});

test('fixed live synthesis works with saved tone while bubbles are disabled, fences ASR, and cancels on pause', async t => {
  const {path} = await fixture(t);
  const samples = wav(); samples.writeUInt32LE(24000,24); samples.writeUInt32LE(48000,28);
  const bank = {'01':samples,'18':samples,'20':samples};
  let complete!: () => void;
  let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  const done = new Promise<void>(resolve => { complete = resolve; });
  let caught = false;
  const speech = new BubbleSpeech({run:async () => assert.fail('does not play to speakers'), close:async()=>{},
    renderStage: async (profile, signal) => {
      assert.equal(profile.transcript,'音色测试'); assert.ok(profile.audio.equals(wav()));
      signal.addEventListener('abort',()=>{caught = true;},{once:true});
      began(); await done; return bank;
    },
  });
  t.after(() => speech.close());
  const signal = new AbortController().signal;
  assert.deepEqual(await speech.prepareStageVoice(signal,()=>true),{ok:false,error:'reference-required'});
  assert.ok((await speech.select(path)).ok);
  assert.ok((await speech.saveTranscriptDraft('音色测试')).ok);
  const synthesis = speech.prepareStageVoice(signal,()=>true);
  await ready;
  assert.equal(speech.status().state,'disabled');
  assert.deepEqual(await speech.suspendForVoiceDraft(),{ok:false,error:'busy'});
  assert.deepEqual(await speech.prepareStageVoice(signal,()=>true),{ok:false,error:'voice-busy'});
  const paused = speech.pause();
  assert.ok(caught);
  complete(); await paused;
  assert.deepEqual(await synthesis,{ok:false,error:'voice-failed'});
  assert.deepEqual(await speech.prepareStageVoice(signal,()=>true),{ok:true,clips:bank});
});

test('explicit live references never fall back to saved desktop tone and use per-role fixed lines', async t => {
  const { path } = await fixture(t);
  const sample = wav(); sample.writeUInt32LE(24000, 24); sample.writeUInt32LE(48000, 28);
  const spoken: string[] = [];
  const speech = new BubbleSpeech({ run: async () => assert.fail('stage capture must not play device audio'), close: async () => {}, renderStageReply: async (profile, text) => {
    assert.equal(profile.transcript, '舞台专属逐字稿'); spoken.push(text); return sample;
  } }); t.after(() => speech.close());
  assert.ok((await speech.select(path)).ok); assert.ok((await speech.saveTranscriptDraft('桌面原有逐字稿')).ok);
  const original = speech.status(), signal = new AbortController().signal;
  assert.deepEqual(await speech.prepareStageVoiceWithReference(undefined, 'longmei', signal, () => true), { ok: false, error: 'reference-required' });
  assert.equal(await speech.prepareStageReplyWithReference(undefined, '你好！', signal, () => true), undefined);
  const reference = { audio: wav(), transcript: '舞台专属逐字稿' };
  const whale = await speech.prepareStageVoiceWithReference(reference, 'dafeiyu', signal, () => true);
  assert.ok(whale.ok); assert.deepEqual(Object.keys(whale.clips).sort(), ['01', '18', '20']);
  assert.deepEqual(spoken, ['嗨，我是鲸鱼妹，欢迎来直播间！', '见到你们，我很开心！', '给大家拍个鲸鱼尾巴～']);
  spoken.length = 0;
  assert.ok((await speech.prepareStageVoiceWithReference(reference, 'longmei', signal, () => true)).ok);
  assert.deepEqual(spoken, [liveActions['01'].line, liveActions['18'].line, liveActions['20'].line]);
  assert.deepEqual(speech.status(), original, 'stage capture must not replace the desktop reference or draft');
});

test('explicit stage capture fences late eligibility, serializes and aborts on pause or external cancellation', async t => {
  let eligible = true, calls = 0, begin!: () => void, complete!: () => void, owned: AbortSignal | undefined;
  const began = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { complete = resolve; });
  const speech = new BubbleSpeech({ run: async () => assert.fail(), close: async () => {}, renderStageReply: async (_profile, _text, signal) => {
    calls++; owned = signal; begin(); await gate; return Buffer.alloc(0);
  } }); t.after(() => speech.close());
  const reference = { audio: wav(), transcript: '有界参考稿' }, controller = new AbortController();
  const rejected = speech.prepareStageVoiceWithReference(reference, 'longmei', controller.signal, () => eligible); eligible = false;
  assert.deepEqual(await rejected, { ok: false, error: 'voice-failed' }); assert.equal(calls, 0);
  eligible = true;
  const pending = speech.prepareStageVoiceWithReference(reference, 'dafeiyu', controller.signal, () => true); await began;
  assert.deepEqual(await speech.prepareStageVoiceWithReference(reference, 'longmei', controller.signal, () => true), { ok: false, error: 'voice-busy' });
  const stopping = speech.pause(); assert.ok(owned?.aborted); complete(); await stopping;
  assert.deepEqual(await pending, { ok: false, error: 'voice-failed' });
  controller.abort(); assert.deepEqual(await speech.prepareStageVoiceWithReference(reference, 'longmei', controller.signal, () => true), { ok: false, error: 'voice-failed' });
});
