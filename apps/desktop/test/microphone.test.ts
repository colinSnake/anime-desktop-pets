import assert from 'node:assert/strict';
import test from 'node:test';
import { MicrophoneGate, isMicrophonePermission } from '../src/microphone-gate.ts';
import { makeMicWav, validMicWav, MicrophoneCapture, type Recording } from '../src/microphone-capture.ts';

const url = 'pet-app://workspace/index.html';
const details = { requestingUrl: url, isMainFrame: true, securityOrigin: 'pet-app://workspace', mediaType: 'audio' };
const deferred = <T>() => { let resolve!: (v: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve }; };

test('microphone permission is audio-only for the workspace main frame', () => {
  assert.equal(isMicrophonePermission('media', details, 'check', 'pet-app://workspace'), true);
  assert.equal(isMicrophonePermission('media', { ...details, mediaTypes: ['audio'] }, 'request'), true);
  for (const bad of [{ isMainFrame: false }, { requestingUrl: 'pet-app://workspace/elsewhere' }, { securityOrigin: 'https://example.invalid' }, { mediaType: 'video' }]) {
    assert.equal(isMicrophonePermission('media', { ...details, ...bad }, 'check', 'pet-app://workspace'), false);
  }
  assert.equal(isMicrophonePermission('media', details, 'check', 'https://example.invalid'), false);
  assert.equal(isMicrophonePermission('media', { ...details, mediaTypes: ['audio', 'video'] }, 'request'), false);
  assert.equal(isMicrophonePermission('display-capture', { ...details, mediaTypes: ['audio'] }, 'request'), false);
});

test('microphone grant expires, is consumed by recording, and only its own ticket can finish once', () => {
  let now = 1;
  const revoked: string[] = [];
  const gate = new MicrophoneGate(id => revoked.push(id), () => now);
  const first = gate.arm()!;
  assert.equal(gate.canOpen(), true);
  assert.equal(gate.arm(), undefined);
  assert.equal(gate.started('other'), false);
  assert.equal(gate.finish(first), undefined);
  assert.equal(gate.started(first), false);
  assert.equal(gate.takeRequest(), true); assert.equal(gate.takeRequest(), false);
  assert.equal(gate.started(first), true);
  assert.equal(gate.canOpen(), false);
  const signal = gate.finish(first)!;
  assert.equal(gate.finish(first), undefined);
  gate.revoke('other'); assert.equal(signal.aborted, false);
  gate.revoke(first); assert.equal(signal.aborted, true);
  const second = gate.arm()!;
  now += 10_000;
  assert.equal(gate.started(second), false);
  assert.equal(gate.canOpen(), false);
  assert.deepEqual(revoked, [first, second]);
});

test('release settles a stalled opening, permits a retry, and stops a late device', async () => {
  const opening = deferred<Recording>(), entered = deferred<void>(), cleaned = deferred<void>();
  const stopped: string[] = [];
  let arms = 0, opens = 0;
  const capture = new MicrophoneCapture({ arm: async () => ({ ok: true, id: `ticket-${++arms}` }), started: async () => true,
    cancel: async id => { stopped.push(id); }, finish: async () => assert.fail('must not transcribe') },
    async () => {
      if (++opens === 1) { entered.resolve(); return opening.promise; }
      return { cancel() { stopped.push('retry-device'); }, stop: async () => undefined };
    });
  const start = capture.start(); await entered.promise;
  assert.deepEqual(await capture.stop(), { ok: false, error: 'cancelled' });
  assert.deepEqual(await start, { ok: false, error: 'cancelled' });
  assert.deepEqual(await capture.start(), { ok: true });
  opening.resolve({ cancel: () => { stopped.push('late-device'); cleaned.resolve(); }, stop: async () => assert.fail('must drop audio') });
  await cleaned.promise;
  capture.cancel();
  assert.deepEqual(stopped, ['ticket-1', 'late-device', 'retry-device', 'ticket-2']);
});

test('repeated stalled device opens remain bounded after cancel', async () => {
  let arms = 0;
  const entered = [deferred<void>(), deferred<void>()], devices = [deferred<Recording>(), deferred<Recording>()];
  const capture = new MicrophoneCapture({ arm: async () => ({ ok: true, id: `ticket-${++arms}` }), started: async () => true,
    cancel: async () => {}, finish: async () => assert.fail('must not transcribe') }, async () => {
      const index = arms - 1; entered[index]!.resolve(); return devices[index]!.promise;
    });
  for (const ready of entered) {
    const attempt = capture.start(); await ready.promise;
    capture.cancel(); assert.deepEqual(await attempt, { ok: false, error: 'cancelled' });
  }
  assert.deepEqual(await capture.start(), { ok: false, error: 'busy' });
  for (const device of devices) device.resolve({ cancel() {}, stop: async () => undefined });
  assert.equal(arms, 2);
});

test('bounded PCM serialization produces exactly one second mono WAV and rejects short input', () => {
  assert.equal(makeMicWav(new Float32Array(15_999)), undefined);
  const samples = new Float32Array(16_000); samples[0] = 1; samples[1] = -1;
  const wav = makeMicWav(samples)!;
  assert.equal(validMicWav(wav), true);
  assert.equal(validMicWav(wav.slice(0, -1)), false);
  assert.equal(validMicWav(new ArrayBuffer(960_046)), false);
  const b = Buffer.from(wav);
  assert.equal(b.subarray(0, 4).toString(), 'RIFF');
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(24), 16_000);
  assert.equal(b.readInt16LE(44), 32767); assert.equal(b.readInt16LE(46), -32768);
  assert.equal(makeMicWav(new Float32Array(480_001)), undefined);
  b.writeUInt16LE(2, 22);
  assert.equal(validMicWav(wav), false);
});

test('release closes capture first, submits only the isolated PCM, and concurrent stops never duplicate it', async () => {
  const audio = makeMicWav(new Float32Array(16_000))!;
  const done = deferred<{ ok: true; text: string }>();
  let deviceClosed = false;
  let submitted = 0;
  const capture = new MicrophoneCapture({ arm: async () => ({ ok: true, id: 'ticket' }), started: async () => true,
    cancel: async () => {}, finish: async (id, bytes) => {
      assert.equal(deviceClosed, true); assert.equal(id, 'ticket'); assert.equal(bytes, audio); submitted++; return done.promise;
    } }, async () => ({ cancel() {}, stop: async () => { deviceClosed = true; return audio; } }));
  assert.deepEqual(await capture.start(), { ok: true });
  const release = capture.stop();
  assert.deepEqual(await capture.stop(), { ok: false, error: 'cancelled' });
  assert.equal(submitted, 1);
  done.resolve({ ok: true, text: '本机口述' });
  assert.deepEqual(await release, { ok: true, text: '本机口述' });
});

test('unauthorized microphones never open, and a revoke discards in-flight text', async () => {
  const done = deferred<{ ok: true; text: string }>();
  let status = false, opens = 0, notices = 0;
  const capture = new MicrophoneCapture({ arm: async () => status ? { ok: true, id: 'ticket' } : { ok: false, error: 'permission-required' },
    started: async () => true, cancel: async () => {}, finish: async () => done.promise }, async () => {
      opens++; return { cancel() {}, stop: async () => makeMicWav(new Float32Array(16_000)) };
    });
  assert.deepEqual(await capture.start(), { ok: false, error: 'permission-required' });
  assert.equal(opens, 0);
  status = true;
  assert.deepEqual(await capture.start(() => { notices++; }), { ok: true });
  const release = capture.stop();
  await Promise.resolve();
  capture.revoked('other'); assert.equal(notices, 0);
  capture.revoked('ticket'); capture.revoked('ticket'); assert.equal(notices, 1);
  done.resolve({ ok: true, text: '迟到文字' });
  assert.deepEqual(await release, { ok: false, error: 'cancelled' });
});

test('fixed Worklet emits silent output, enforces its ceiling, and transfers samples once', async () => {
  const { readFile } = await import('node:fs/promises');
  const { runInNewContext } = await import('node:vm');
  const messages: unknown[] = [];
  const port: { onmessage?: (event: { data: string }) => void; postMessage(data: unknown): void } = {
    postMessage(data) { messages.push(data); },
  };
  let Processor!: new () => { process(samples: Float32Array[][], outputs: Float32Array[][]): boolean };
  runInNewContext(await readFile(new URL('../src/microphone-worklet.js', import.meta.url), 'utf8'), {
    Float32Array, AudioWorkletProcessor: class { port = port; },
    registerProcessor(name: string, ctor: typeof Processor) { assert.equal(name, 'pet-microphone'); Processor = ctor; },
  });
  const recorder = new Processor();
  const input = new Float32Array(128).fill(0.5), output = new Float32Array(128);
  for (let i = 0; i < 3752; i++) assert.equal(recorder.process([[input]], [[output]]), true);
  assert.equal(messages.length, 1); assert.equal(messages[0], 'limit');
  assert.equal(output.some(Boolean), false);
  port.onmessage!({ data: 'stop' }); port.onmessage!({ data: 'stop' });
  assert.equal((messages[1] as Float32Array).length, 480_000);
  assert.equal((messages[1] as Float32Array)[479_999], 0.5);
  assert.equal(messages.length, 2);
  assert.equal(recorder.process([[input]], [[output]]), false);
});

test('focus revocation while waiting for speech to stop cannot arm a pre-revocation gesture', async () => {
  const gate = new MicrophoneGate(() => {});
  const stopped = deferred<boolean>();
  let focused = true;
  const opening = gate.armAfter(() => stopped.promise, () => focused);
  assert.equal(gate.busy, true);
  assert.equal(gate.canOpen(), false);
  focused = false; gate.revoke(); focused = true;
  stopped.resolve(true);
  assert.equal(await opening, undefined);
  assert.equal(gate.busy, false);
  assert.equal(await gate.armAfter(async () => false, () => focused), undefined);
  assert.ok(await gate.armAfter(async () => true, () => focused));
  assert.equal(gate.canOpen(), true);
  gate.revoke();
});
