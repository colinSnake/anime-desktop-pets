import { useEffect, useRef, type ReactNode } from 'react';
import { isSpeechEnableInput, type SpeechBridge, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { InteractionCardHeading, InteractionHero, InteractionLayout } from './InteractionLayout.tsx';
import type { useBubbleSpeech } from './useBubbleSpeech.ts';
import { patch, type Draft } from './WorkspacePanels.tsx';

type SpeechDraft = { referenceTranscript?: string };
export const emptySpeech: SpeechDraft = {};
const transcriptLimit = 4096;
const encoder = new TextEncoder();
const states = {
  unavailable: ['本机语音不可用', ''],
  disabled: ['未启用', ''],
  enabled: ['已启用', 'good'],
  loading: ['准备中', 'warn'],
  speaking: ['播报中', 'good'],
  failed: ['播报失败', 'bad'],
} satisfies Record<SpeechStatus['state'], [string, string]>;

export function SpeechPage({ draft, session, bridge, appearance }: {
  draft: Draft<SpeechDraft>; session: ReturnType<typeof useBubbleSpeech>; bridge?: SpeechBridge; appearance?: ReactNode;
}) {
  const { speech, busy, previewAction, error, run, unconfirmed, scheduleTranscriptSave, flushTranscriptSave, cancelTranscriptSave } = session;
  const chooseReference = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { void bridge?.stopPreview?.().catch(() => {}); }, [bridge]);
  const needsStop = unconfirmed || (!!speech && speech.state !== 'disabled' && speech.state !== 'unavailable');
  const editable = !!bridge && speech?.state === 'disabled' && !unconfirmed && !busy;
  const selected = speech?.hasReference === true;
  const input = { referenceTranscript: draft.value.referenceTranscript ?? speech?.referenceTranscript ?? '' };
  const bytes = encoder.encode(input.referenceTranscript).length;
  const valid = isSpeechEnableInput(input);
  const invalid = bytes > transcriptLimit || (!!input.referenceTranscript.trim() && !valid);
  const toast = error || (speech?.storageUnavailable ? '音色读取失败，请退出后重开。'
    : speech?.state === 'failed' ? '播报失败，请停止后重试。'
    : speech?.state === 'enabled' && speech.runtime === 'failed' ? '语音模型预载失败，可以点「试听一句」重试。'
    : invalid ? '请检查逐字稿（最多 4096 字节）。' : '');

  return <InteractionLayout page="speech" title="语音互动" appearance={appearance} toast={toast}>
    <InteractionHero page="speech" eyebrow="本机语音" title="气泡播报">
      <BubbleSpeechStatus speech={speech} connected={!!bridge} busy={busy} unconfirmed={unconfirmed} />
    </InteractionHero>
    <section className="interaction-card" aria-labelledby="speech-setup">
      <InteractionCardHeading id="speech-setup" title="设置参考音色" />
      <div className="interaction-setup">
        <section className="interaction-step speech-reference-step">
          <h3><span className="interaction-step-number" aria-hidden="true">01</span> 参考音频</h3>
          <div className="interaction-file" data-ready={selected}>
            <span className="interaction-file-icon"><PetNookIcon name="audio" /></span>
            <div><strong>{selected ? '已选择参考音频' : '还未选择音频'}</strong><small>PCM WAV · 1–30 秒 · ≤ 6 MiB</small></div>
          </div>
          <div className="interaction-step-actions">
            <button ref={chooseReference} className="interaction-button secondary" type="button" disabled={!editable} onClick={() => {
              const transcript = input.referenceTranscript;
              void flushTranscriptSave().then(saved => saved ? run(actions => actions.selectReference()) : undefined).then(result => {
                if (!result?.ok || !result.speech.hasReference) return;
                patch(draft, { referenceTranscript: transcript });
                scheduleTranscriptSave(transcript);
              });
            }}>
              <PetNookIcon name="plus" /><span>{selected ? '更换参考音频' : '选择参考音频'}</span>
            </button>
            {selected && <button className="interaction-button quiet" type="button" disabled={!editable} aria-label="移除参考音频" onClick={() => {
              void flushTranscriptSave().then(saved => saved ? run(actions => actions.clearReference()) : undefined).then(result => {
                if (!result?.ok) return;
                cancelTranscriptSave();
                patch(draft, { referenceTranscript: undefined });
                requestAnimationFrame(() => { if (document.activeElement === document.body) chooseReference.current?.focus(); });
              });
            }}>移除</button>}
          </div>
        </section>
        <section className="interaction-step">
          <div className="interaction-step-heading">
            <label htmlFor="speech-transcript"><span className="interaction-step-number" aria-hidden="true">02</span> 音频逐字稿</label>
            <output id="speech-byte-count" htmlFor="speech-transcript" aria-live="off" data-invalid={invalid}>{`${bytes} / ${transcriptLimit} 字节`}</output>
          </div>
          <textarea id="speech-transcript" className="interaction-field" aria-describedby="speech-byte-count" aria-invalid={invalid}
            placeholder="填写音频原话…" rows={5} maxLength={transcriptLimit} value={input.referenceTranscript} readOnly={!editable}
            onChange={event => {
              const value = event.currentTarget.value;
              patch(draft, { referenceTranscript: value });
              if (selected) scheduleTranscriptSave(value);
            }} />
        </section>
      </div>
      <SpeechPreviewControls speech={speech} connected={typeof bridge?.preview === 'function' && typeof bridge?.stopPreview === 'function'}
        busy={busy} previewAction={previewAction} unconfirmed={unconfirmed}
        onPreview={() => { void run('preview'); }} onStop={() => { void run('stopPreview'); }}>
        <button type="button" className={`interaction-button ${needsStop ? 'secondary' : 'primary'}`} disabled={needsStop ? !bridge || busy : !editable || !selected || !valid}
          onClick={() => {
            if (needsStop) {
              cancelTranscriptSave();
              void run(actions => actions.disable());
              return;
            }
            void flushTranscriptSave().then(saved => saved ? run(actions => actions.enable(input)) : undefined).then(result => {
              if (result?.ok && result.speech.referenceTranscript !== undefined) patch(draft, { referenceTranscript: undefined });
            });
          }}>
          <PetNookIcon name="audio" /><span>{needsStop ? '停止播报' : '启用气泡播报'}</span>
        </button>
      </SpeechPreviewControls>
    </section>
  </InteractionLayout>;
}

const enabledRuntime = {
  cold: ['已启用 · 模型待加载', 'warn'],
  preparing: ['已启用 · 模型准备中', 'warn'],
  ready: ['已启用 · 模型已就绪', 'good'],
  failed: ['已启用 · 模型预载失败', 'bad'],
} satisfies Record<NonNullable<SpeechStatus['runtime']>, [string, string]>;

export function BubbleSpeechStatus({ speech, connected, busy, unconfirmed }: {
  speech?: SpeechStatus; connected: boolean; busy: boolean; unconfirmed: boolean;
}) {
  const [label, tone] = busy ? ['正在处理', 'warn'] : unconfirmed ? ['播报状态未确认', 'warn']
    : !speech ? [connected ? '正在连接' : '本机语音不可用', '']
    : speech.state === 'enabled' && speech.runtime ? enabledRuntime[speech.runtime] : states[speech.state];
  return <span className="interaction-pill dot" role="status" data-tone={tone}>{label}</span>;
}

/** The preview action shares the setup footer but only controls the fixed preview. */
export function SpeechPreviewControls({ speech, connected, busy, previewAction, unconfirmed, onPreview, onStop, children }: {
  speech?: SpeechStatus; connected: boolean; busy: boolean; previewAction?: 'preview' | 'stopPreview'; unconfirmed: boolean;
  onPreview(): void; onStop(): void; children?: ReactNode;
}) {
  const supported = connected && speech?.previewAvailable === true;
  const showStop = !!speech?.previewing || previewAction !== undefined;
  const ready = supported && (showStop ? !busy || previewAction === 'preview'
    : !busy && !unconfirmed && speech.state === 'enabled');
  const restart = speech && speech.state !== 'unavailable' && !supported;
  return <div className="interaction-card-footer">
    {restart && <span id="speech-preview-restart">退出后重开应用，再试听。</span>}
    <div className="speech-footer-actions">
      <button type="button" className="interaction-button secondary" disabled={!ready}
        aria-describedby={restart ? 'speech-preview-restart' : undefined} onClick={showStop ? onStop : onPreview}>
        <PetNookIcon name={showStop ? 'stop' : 'audio'} /><span>{showStop ? '停止播放' : '试听一句'}</span>
      </button>
      {children}
    </div>
  </div>;
}
