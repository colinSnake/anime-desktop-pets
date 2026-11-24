import { makeMicWav, micMaxSamples, micRate, type Recording } from './microphone-capture.ts';
import { MICROPHONE_WORKLET_URL } from './security.ts';

/** Never expose the MediaStream, audio graph or PCM to the renderer bridge. */
export async function openMicrophone(signal: AbortSignal, deviceLost: () => void): Promise<Recording> {
  signal.throwIfAborted();
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let recorder: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveStop: ((audio?: ArrayBuffer) => void) | undefined;
  let closed = false;
  const stopTracks = () => {
    for (const track of stream?.getTracks() ?? []) { track.removeEventListener('ended', deviceLost); track.stop(); }
    stream = undefined;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopTracks();
    clearTimeout(timer);
    signal.removeEventListener('abort', close);
    if (recorder) { recorder.port.onmessage = null; recorder.port.close(); recorder.disconnect(); }
    source?.disconnect();
    if (context) void context.close().catch(() => {});
    resolveStop?.();
    resolveStop = undefined;
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (signal.aborted) { for (const track of acquired.getTracks()) track.stop(); signal.throwIfAborted(); }
    stream = acquired;
    const tracks = stream.getTracks();
    if (tracks.length !== 1 || tracks[0]?.kind !== 'audio' || tracks[0].readyState !== 'live') throw new Error('unexpected_audio_device');
    tracks[0].addEventListener('ended', deviceLost, { once: true });
    context = new AudioContext({ sampleRate: micRate });
    if (context.sampleRate !== micRate) throw new Error('unexpected_audio_sample_rate');
    await context.audioWorklet.addModule(MICROPHONE_WORKLET_URL);
    signal.throwIfAborted();
    recorder = new AudioWorkletNode(context, 'pet-microphone', {
      channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1],
    });
    recorder.addEventListener('processorerror', deviceLost, { once: true });
    recorder.port.onmessage = ({ data }) => {
      if (data === 'limit' && !resolveStop) { deviceLost(); return; }
      if (!resolveStop || !(data instanceof Float32Array) || data.length > micMaxSamples) return;
      const done = resolveStop;
      resolveStop = undefined;
      const audio = makeMicWav(data);
      close();
      done(audio);
    };
    source = context.createMediaStreamSource(stream);
    source.connect(recorder);
    recorder.connect(context.destination); // Worklet output is always silent (no monitor/echo).
    await context.resume();
    signal.throwIfAborted();
    return {
      cancel: close,
      stop: () => new Promise<ArrayBuffer | undefined>(resolve => {
        if (closed) { resolve(undefined); return; }
        stopTracks();
        source!.disconnect();
        resolveStop = resolve;
        timer = setTimeout(close, 500);
        recorder!.port.postMessage('stop');
      }),
    };
  } catch (cause) { close(); throw cause; }
}
