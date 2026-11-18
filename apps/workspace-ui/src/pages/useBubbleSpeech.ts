import { useEffect, useRef, useState } from 'react';
import { isSpeechResult, type SpeechBridge, type SpeechResult, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';

const messages: Record<Extract<SpeechResult, { ok: false }>['error'], string> = {
  unavailable: '暂时无法确认播报状态，请稍后重试。',
  invalid: '请输入参考音频的准确逐字稿（最多 4096 字节）。',
  'invalid-audio': '选择失败。请选择 1–30 秒、最多 6 MiB 的 PCM WAV 文件。',
  'reference-required': '请先选择参考音频。',
  busy: '正在处理播报设置，请稍后再试。',
};
const unavailable = { ok: false, error: 'unavailable' } as const;
async function safe(operation: () => Promise<SpeechResult>): Promise<SpeechResult> {
  try { const result = await operation(); return isSpeechResult(result) ? result : unavailable; }
  catch { return unavailable; }
}

export function useBubbleSpeech(bridge?: SpeechBridge) {
  const [speech, setSpeech] = useState<SpeechStatus>();
  const [error, setError] = useState('');
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false), revision = useRef(0);
  useEffect(() => {
    if (!bridge) return;
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
    return () => { disposed = true; clearTimeout(timer); };
  }, [bridge]);
  const run = async (operation: (bridge: SpeechBridge) => Promise<SpeechResult>) => {
    if (!bridge || inFlight.current) return;
    inFlight.current = true; revision.current++; setBusy(true); setError('');
    const result = await safe(() => operation(bridge));
    if (result.ok) { setSpeech(result.speech); setUnconfirmed(false); }
    else {
      setError(messages[result.error]);
      if (result.error === 'unavailable') setUnconfirmed(true);
    }
    inFlight.current = false; setBusy(false);
  };
  return { speech, busy, error, run, unconfirmed };
}
