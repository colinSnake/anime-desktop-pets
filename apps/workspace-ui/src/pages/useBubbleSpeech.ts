import { useCallback, useEffect, useRef, useState } from 'react';
import { createSpeechTranscriptSaver, type SpeechTranscriptSaver } from './speech-transcript-save.ts';
import { isSpeechResult, isSpeechTranscriptInput, type SpeechBridge, type SpeechResult, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';

const messages: Record<Extract<SpeechResult, { ok: false }>['error'], string> = {
  unavailable: '暂时无法确认播报状态，请稍后重试。',
  invalid: '请输入参考音频的准确逐字稿（最多 4096 字节）。',
  'invalid-audio': '选择失败。请选择 1–30 秒、最多 6 MiB 的 PCM WAV 文件。',
  'reference-required': '请先选择参考音频。',
  busy: '语音忙，请稍后再试。',
  storage: '音色保存状态未确认，请退出后重开。',
};
const unavailable = { ok: false, error: 'unavailable' } as const;
type PreviewAction = 'preview' | 'stopPreview';
type SpeechAction = PreviewAction | 'change';
async function safe(operation: () => Promise<SpeechResult>): Promise<SpeechResult> {
  try { const result = await operation(); return isSpeechResult(result) ? result : unavailable; }
  catch { return unavailable; }
}

export function useBubbleSpeech(bridge: SpeechBridge | undefined, active: boolean) {
  const [speech, setSpeech] = useState<SpeechStatus>();
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [pending, setPending] = useState<SpeechAction>();
  const inFlight = useRef<SpeechAction | undefined>(undefined), revision = useRef(0);
  const transcriptSaver = useRef<SpeechTranscriptSaver | undefined>(undefined);
  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const saver = createSpeechTranscriptSaver(async referenceTranscript => {
      const result = await safe(() => bridge.saveTranscript({ referenceTranscript }));
      if (disposed) {
        if (!result.ok) throw new Error(result.error);
        return;
      }
      if (result.ok) { setSpeech(result.speech); setUnconfirmed(false); setError(''); }
      else {
        setError(`逐字稿尚未保存。${messages[result.error]}`);
        if (result.error === 'unavailable') setUnconfirmed(true);
        throw new Error(result.error);
      }
    }, 400);
    transcriptSaver.current = saver;
    return () => {
      disposed = true;
      if (transcriptSaver.current === saver) transcriptSaver.current = undefined;
      void saver.flush().catch(() => {});
    };
  }, [bridge]);
  const scheduleTranscriptSave = useCallback((value: string) => {
    setError('');
    if (isSpeechTranscriptInput({ referenceTranscript: value })) transcriptSaver.current?.schedule(value);
    else transcriptSaver.current?.cancel();
  }, []);
  const flushTranscriptSave = useCallback(async () => {
    const saver = transcriptSaver.current;
    if (!saver) return false;
    try { await saver.flush(); return true; } catch { return false; }
  }, []);
  const cancelTranscriptSave = useCallback(() => transcriptSaver.current?.cancel(), []);
  useEffect(() => {
    if (!bridge || !active) return;
    const saver = transcriptSaver.current;
    // The module owns this queue across page navigation. Retry an unsaved
    // draft on return, but do not keep polling or retrying while off-page.
    void saver?.flush().catch(() => {});
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const expected = revision.current;
      if (!inFlight.current) {
        const result = await safe(() => bridge.status());
        if (!disposed && expected === revision.current) {
          setUnconfirmed(!result.ok);
          if (result.ok) setSpeech(result.speech);
        }
      }
      if (!disposed) timer = setTimeout(() => { void read(); }, 1200);
    };
    void read();
    return () => { disposed = true; clearTimeout(timer); void saver?.flush().catch(() => {}); };
  }, [bridge, active]);
  const run = async (operation: PreviewAction | ((bridge: SpeechBridge) => Promise<SpeechResult>)) => {
    const action = typeof operation === 'function' ? 'change' : operation;
    // The preview stop can overtake its start. The main process fences late starts by revision.
    if (!bridge || (inFlight.current && !(inFlight.current === 'preview' && action === 'stopPreview'))) return;
    const expected = ++revision.current;
    inFlight.current = action; setPending(action); setError('');
    const result = await safe(() => typeof operation === 'function' ? operation(bridge) : bridge[operation]());
    if (revision.current !== expected) return;
    if (result.ok) { setSpeech(result.speech); setUnconfirmed(false); }
    else {
      setError(messages[result.error]);
      if (result.error === 'unavailable') setUnconfirmed(true);
    }
    inFlight.current = undefined; setPending(undefined);
    return result;
  };
  return { speech, busy: pending !== undefined, previewAction: pending === 'change' ? undefined : pending,
    error, run, unconfirmed, scheduleTranscriptSave, flushTranscriptSave, cancelTranscriptSave };
}
