import { isSpeechEnableInput, type SpeechBridge, type SpeechStatus } from '../../../../packages/contracts/src/speech.ts';
import { useBubbleSpeech } from './useBubbleSpeech.ts';
import { DisabledAction, Field, InlineFooter, ModulePage, OptionRow, Panel, Split, ToggleRow, patch, type Draft } from './WorkspacePanels.tsx';

type SpeechDraft = { referenceTranscript: string; replyBubble: boolean; readReply: boolean };
export const emptySpeech: SpeechDraft = { referenceTranscript: '', replyBubble: false, readReply: false };
const states: Record<SpeechStatus['state'], string> = {
  unavailable: '本机语音运行时不可用', disabled: '已关闭', enabled: '已启用 · 等待互动气泡',
  loading: '正在准备本机播报', speaking: '正在播报', failed: '播报失败 · 请确认停止',
};

export function SpeechPage({ draft, bridge }: { draft: Draft<SpeechDraft>; bridge?: SpeechBridge }) {
  const { speech, busy, error, run, unconfirmed } = useBubbleSpeech(bridge);
  const active = speech && ['enabled', 'loading', 'speaking', 'failed'].includes(speech.state);
  const available = !!speech && speech.state !== 'unavailable' && !unconfirmed;
  const selected = speech?.hasReference === true;
  const input = { referenceTranscript: draft.value.referenceTranscript };
  return <ModulePage title="语音互动" description="设置桌宠互动气泡的本机播报，以及查看语音对话功能。" preview={false}>
    <aside className="module-notice" aria-label="语音范围"><strong>仅本次会话</strong><p>开启后，自有桌宠的互动气泡可由本机朗读。参考音频和逐字稿不会进入聊天或发送到线上，退出后需要重新选择和开启。</p></aside>
    <Split main={<>
      <Panel title="桌宠气泡播报" description="使用本机 Qwen TTS。选择你有权使用的参考音频，并逐字填入其中说的话。">
        <OptionRow title="参考音频" detail={selected ? '已准备本次会话的参考音频。' : '请选择 1–30 秒、最多 6 MiB 的 PCM WAV。'}>
          <button className="button secondary" type="button" disabled={!available || active || busy} onClick={() => { void run(actions => actions.selectReference()); }}>选择参考音频</button>
          <button className="button secondary" type="button" disabled={!available || !selected || active || busy} onClick={() => { void run(actions => actions.clearReference()); }}>移除参考音频</button>
        </OptionRow>
        <div className="module-inset"><Field label="参考音频的准确转写" placeholder="逐字写下参考音频里的话" value={draft.value.referenceTranscript} limit={4096} multiline readOnly={active || busy} onChange={referenceTranscript => patch(draft, { referenceTranscript })} /></div>
        <OptionRow title="朗读桌宠互动气泡" detail="桌宠实际显示互动气泡后才会播报。开启不会立即播放测试声音。"><span className="badge" role="status">{busy ? '正在处理' : unconfirmed ? '播报状态未确认' : speech ? states[speech.state] : bridge ? '正在查询播报状态' : '未连接语音桥'}</span></OptionRow>
        {error && <p className="error module-copy" role="alert">{error}</p>}
        <InlineFooter hint="停止播报会丢弃正在处理和等待的气泡。">
          <button className="button primary" type="button" disabled={!available || active || !selected || !isSpeechEnableInput(input) || busy} onClick={() => { void run(actions => actions.enable(input)); }}>启用气泡播报</button>
          <button className="button secondary" type="button" disabled={!bridge || (!active && !unconfirmed) || busy} onClick={() => { void run(actions => actions.disable()); }}>停止气泡播报</button>
        </InlineFooter>
      </Panel>
      <Panel title="语音对话偏好" description="以下偏好仅供试填，语音对话尚未接入。">
        <ToggleRow label="显示回复气泡" detail="在桌宠旁显示语音对话的回复。" checked={draft.value.replyBubble} onChange={replyBubble => patch(draft, { replyBubble })} />
        <ToggleRow label="朗读生成的回复" detail="朗读对话中生成的文字回复。" checked={draft.value.readReply} onChange={readReply => patch(draft, { readReply })} />
        <InlineFooter hint="此处试调的偏好不会应用到桌宠或设备。"><DisabledAction>保存语音设置</DisabledAction></InlineFooter>
      </Panel>
    </>} aside={<>
      <Panel title="麦克风"><OptionRow title="麦克风设备" detail="设备和输入电平尚未读取。"><DisabledAction>选择麦克风</DisabledAction><DisabledAction>检测麦克风</DisabledAction></OptionRow></Panel>
      <Panel title="在线授权"><ToggleRow label="AI 生成日常陪伴气泡" detail="需要单独同意使用在线模型；当前不可授权。" /></Panel>
      <Panel title="语音体验"><p className="module-copy">语音会话和在线模型演示尚未接入。</p><div className="module-actions"><DisabledAction>开始语音聊天</DisabledAction><DisabledAction>运行在线模型演示</DisabledAction></div></Panel>
    </>} />
  </ModulePage>;
}
