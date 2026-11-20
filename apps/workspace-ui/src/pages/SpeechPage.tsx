import { useRef, type ReactNode } from 'react';
import { isSpeechEnableInput, type SpeechBridge, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { InteractionCardHeading, InteractionDisclosure, InteractionHero, InteractionLayout } from './InteractionLayout.tsx';
import { useBubbleSpeech } from './useBubbleSpeech.ts';
import { patch, type Draft } from './WorkspacePanels.tsx';

type SpeechDraft = { referenceTranscript: string };
export const emptySpeech: SpeechDraft = { referenceTranscript: '' };
const transcriptLimit = 4096;
const encoder = new TextEncoder();
const waitingForBubble = '启用后，桌宠显示互动气泡时才会朗读。';
const states = {
  unavailable: ['本机运行时不可用', '', '当前无法启用气泡播报。'],
  disabled: ['未启用', '', waitingForBubble],
  enabled: ['已启用 · 等待气泡', 'good', '等待下一条桌宠互动气泡，不会主动播放逐字稿。'],
  loading: ['正在准备播报', 'warn', '正在准备朗读本次互动气泡。'],
  speaking: ['正在播报', 'good', '正在本机朗读互动气泡。'],
  failed: ['播报失败', 'bad', '停止本次播报后，可以重新启用。'],
} satisfies Record<SpeechStatus['state'], [string, string, string]>;

export function SpeechPage({ draft, bridge, appearance }: { draft: Draft<SpeechDraft>; bridge?: SpeechBridge; appearance?: ReactNode }) {
  const { speech, busy, error, run, unconfirmed } = useBubbleSpeech(bridge);
  const chooseReference = useRef<HTMLButtonElement>(null);
  const needsStop = unconfirmed || (!!speech && speech.state !== 'disabled' && speech.state !== 'unavailable');
  const editable = !!bridge && speech?.state === 'disabled' && !unconfirmed && !busy;
  const selected = speech?.hasReference === true;
  const input = { referenceTranscript: draft.value.referenceTranscript };
  const bytes = encoder.encode(input.referenceTranscript).length;
  const valid = isSpeechEnableInput(input);
  const invalid = bytes > transcriptLimit || (!!input.referenceTranscript.trim() && !valid);
  const [stateLabel, tone, detail] = unconfirmed ? ['播报状态未确认', 'warn', '请先停止播报，再继续编辑参考音色。']
    : speech ? states[speech.state] : [bridge ? '正在查询播报状态' : '未连接语音桥', '', waitingForBubble];
  const issue = error || (speech?.state === 'failed' ? '播报未完成。请先停止本次播报。'
    : bytes > transcriptLimit ? '逐字稿超过 4096 字节，请缩短后再启用。' : invalid ? '逐字稿包含不支持的字符，请修改后再启用。' : '');
  const next = needsStop ? '停止会丢弃正在处理和等待的气泡。'
    : speech?.state !== 'disabled' ? '本机运行时可用后才能启用。'
    : !selected ? '先选择一段参考音频。' : !valid ? '再填写与音频一致的逐字稿。' : '准备好了。启用后，本次会话生效。';

  return <InteractionLayout page="speech" title="语音互动" description="让桌宠在本机读出互动气泡。" appearance={appearance}>
    <InteractionHero page="speech" eyebrow="本机语音" title="气泡播报" description={detail}>
      <span className="interaction-pill dot" role="status" data-tone={busy ? 'warn' : tone}>{busy ? '正在处理' : stateLabel}</span>
    </InteractionHero>
    <section className="interaction-card" aria-labelledby="speech-setup">
      <InteractionCardHeading id="speech-setup" title="设置参考音色" description="准备一段参考音频和对应的逐字稿。" context="仅本次会话" />
      <div className="interaction-setup">
        <section className="interaction-step">
          <h3><span className="interaction-step-number" aria-hidden="true">01</span> 参考音频</h3>
          <div className="interaction-file" data-ready={selected}>
            <span className="interaction-file-icon"><PetNookIcon name="audio" /></span>
            <div><strong>{selected ? '已选择参考音频' : '还未选择音频'}</strong><small>PCM WAV · 1–30 秒 · ≤ 6 MiB</small></div>
          </div>
          <div className="interaction-step-actions">
            <button ref={chooseReference} className="interaction-button secondary" type="button" disabled={!editable} onClick={() => { void run(actions => actions.selectReference()); }}>
              <PetNookIcon name="plus" /><span>{selected ? '更换参考音频' : '选择参考音频'}</span>
            </button>
            {selected && <button className="interaction-button quiet" type="button" disabled={!editable} aria-label="移除参考音频" onClick={() => {
              void run(actions => actions.clearReference()).then(() => requestAnimationFrame(() => {
                if (document.activeElement === document.body) chooseReference.current?.focus();
              }));
            }}>移除</button>}
          </div>
        </section>
        <section className="interaction-step">
          <div className="interaction-step-heading">
            <label htmlFor="speech-transcript"><span className="interaction-step-number" aria-hidden="true">02</span> 音频逐字稿</label>
            <output id="speech-byte-count" htmlFor="speech-transcript" aria-live="off" data-invalid={invalid}>{`${bytes} / ${transcriptLimit} 字节`}</output>
          </div>
          <textarea id="speech-transcript" className="interaction-field" aria-describedby="speech-transcript-hint speech-byte-count" aria-invalid={invalid}
            placeholder="逐字输入参考音频里的话…" rows={3} maxLength={transcriptLimit} value={input.referenceTranscript} readOnly={!editable}
            onChange={event => patch(draft, { referenceTranscript: event.currentTarget.value })} />
          <p className="interaction-field-hint" id="speech-transcript-hint">填写音频原话，不是要播报的内容。</p>
        </section>
      </div>
      {issue && <p className="interaction-error" role="alert">{issue}</p>}
      <div className="interaction-card-footer"><span>{next}</span>
        <button type="button" className={`interaction-button ${needsStop ? 'secondary' : 'primary'}`} disabled={needsStop ? !bridge || busy : !editable || !selected || !valid}
          onClick={() => { void run(actions => needsStop ? actions.disable() : actions.enable(input)); }}>
          <PetNookIcon name="audio" /><span>{needsStop ? '停止气泡播报' : '启用气泡播报'}</span>
        </button>
      </div>
    </section>
    <InteractionDisclosure title="隐私与功能范围" icon="lock">
      <p>音频与逐字稿只用于本次本机播报，不会发送到线上。请使用你有权使用的音频。麦克风、语音对话和在线生成气泡尚未接入。</p>
    </InteractionDisclosure>
  </InteractionLayout>;
}
