import { useEffect, useSyncExternalStore } from 'react';
import { identityDraftOf, isIdentityWriteInput, type IdentityDraft, type IdentityWriteError } from '../../../../packages/contracts/src/characters.ts';
import { ChatShareControl } from './ChatShareControl.tsx';
import { emptyIdentity, emptyIdentityEditorState, identityDirty, type IdentityEditor } from './identity-editor.ts';
import { DisabledAction, Disclosure, EmptyState, Field, InlineFooter, ModulePage, OptionRow, Panel, PreviewNotice, patch, type Draft } from './WorkspacePanels.tsx';

const common = [['personality', '性格', '这个角色怎样待人、怎样处理不确定？'], ['speakingStyle', '表达方式', '希望它用怎样的语气和节奏？'], ['relationship', '与你的关系', '这个桌边伙伴怎样称呼你、怎样陪伴你？']] as const;
const extended = [['role', '身份定位'], ['background', '背景'], ['values', '核心价值观'], ['motivations', '当前愿望与长期方向'], ['knowledgeScope', '知识与擅长边界'], ['boundaries', '边界']] as const;
const noSubscription = () => () => {};
const noState = () => emptyIdentityEditorState;
const errors: Record<IdentityWriteError, string> = {
  'not-found': '这个实例已不在当前工作区，请重新选择。', unavailable: '暂时无法访问身份资料。', invalid: '身份格式不符合要求，请检查字段。',
  limit: '身份资料超过存储上限，请减少文字后重试。', conflict: '保存版本已变化，草稿已保留。请先读取最新资料。',
  busy: '身份资料正在被使用，草稿已保留，请稍后重试。', 'history-not-found': '该历史版本已不可用，请重新读取。',
  'credential-like': '身份中将用于聊天的字段可能包含凭证，未授权。',
  'write-outcome-unknown': '上次写入结果未确认，请先重新读取当前资料。',
};
const notices = { shared: '已保存在线聊天授权。', unshared: '已撤回在线聊天授权。', saved: '身份已保存。', restored: '已恢复为新版本。', unchanged: '内容与已保存版本相同。', reloaded: '已重新读取当前保存资料。' } as const;

export function IdentityPage({ draft, connected, instance, editor }: {
  draft: Draft<IdentityDraft>; connected?: boolean; instance?: { id: string; displayName?: string }; editor?: IdentityEditor;
}) {
  const state = useSyncExternalStore(editor?.subscribe ?? noSubscription, editor?.getSnapshot ?? noState, editor?.getSnapshot ?? noState);
  useEffect(() => {
    const initial = editor?.getSnapshot();
    if (initial && !initial.snapshot && !initial.error) void editor?.load();
  }, [editor]);
  const { snapshot, busy, error, review, inspecting, notice } = state;
  const dirty = identityDirty(state);
  const selectedVersion = typeof inspecting === 'number' ? snapshot?.identityHistory.find(item => item.revision === inspecting) : undefined;
  const inspected = inspecting === 'saved' ? snapshot?.identity : selectedVersion;
  const value = connected ? inspecting === undefined ? state.draft ?? emptyIdentity : inspected ? identityDraftOf(inspected) : emptyIdentity : draft.value;
  const readOnly = !!connected && (!snapshot || !!busy || !!review || inspecting !== undefined);
  const canSave = !!snapshot && dirty && inspecting === undefined && !review && !busy &&
    isIdentityWriteInput('saveIdentity', { petID: snapshot.petID, expectedRevision: snapshot.revision, draft: state.draft });
  const change = (key: keyof IdentityDraft, text: string) => { if (connected) editor?.change(key, text); else patch(draft, { [key]: text }); };
  const status = !instance ? '请先在「桌宠」选择一个实例。'
    : busy === 'read' || (!snapshot && !error) ? '正在读取身份资料…'
    : busy === 'save' ? '正在保存身份…' : busy === 'restore' ? '正在恢复历史版本…'
    : busy === 'share' ? '正在更新聊天授权…'
    : review === 'read-required' ? (dirty ? '草稿仍保留，重新读取后可继续。' : '请重新读取身份资料。')
    : review === 'review-required' ? '正在查看最新保存版本。返回草稿后，可对照修改再保存。'
    : selectedVersion ? `正在查看历史版本 ${selectedVersion.revision}。`
    : notice ? notices[notice] : snapshot?.identity ? `当前保存版本 ${snapshot.identity.revision}。` : snapshot ? '这个实例还没有保存身份。' : '';
  return <ModulePage title="身份" description="为桌边伙伴写下它是谁、怎样表达，以及应该守住的边界。">
    {connected ? <aside className="module-notice" aria-label="实例身份">
      <strong>{instance?.displayName || '当前实例'}</strong><p role="status">{status}</p>
      {error && <p className="error" role="alert">{errors[error]}</p>}
      {!!editor && ((error === 'unavailable' && !busy) || (review === 'read-required' && !busy)) &&
        <button className="button secondary" type="button" onClick={() => { void editor.load(); }}>读取最新身份</button>}
    </aside> : <PreviewNotice>可试填身份草稿；角色资料尚未连接，编辑不会保存到实例，也不会进入聊天。</PreviewNotice>}
    <Panel title="角色资料" focusHeading={inspecting !== undefined}>
      <div className="module-stack">
        <Field label="名称" placeholder="给这个角色起个名字" limit={80} value={value.name} readOnly={readOnly} onChange={name => change('name', name)} />
        {common.map(([key, label, placeholder]) => <Field key={key} label={label} placeholder={placeholder} limit={2000} value={value[key]} readOnly={readOnly} onChange={text => change(key, text)} multiline />)}
        <Disclosure title="基础设定"><div className="module-fields two-columns">{extended.map(([key, label]) => <Field key={key} label={label} limit={2000} value={value[key]} readOnly={readOnly} onChange={text => change(key, text)} multiline />)}</div></Disclosure>
      </div>
      {inspecting !== undefined ? <InlineFooter hint={selectedVersion && dirty ? '请先保存或放弃草稿，再恢复历史版本。' : selectedVersion ? '恢复会创建一个新版本，并保留现在的版本。' : '最新保存的内容仅供核对，草稿仍保留。'}>
        <button className="button secondary" type="button" disabled={!!busy} onClick={() => editor?.returnToDraft()}>返回草稿</button>
        {selectedVersion && <button className="button primary" type="button" disabled={dirty || !!busy} onClick={() => { void editor?.restore(); }}>恢复为新版本</button>}
      </InlineFooter> : <InlineFooter hint={!connected ? '这里的编辑不会替换任何已保存资料。' : dirty && !canSave && !readOnly ? '请填写名称并检查文字长度。' : '仅保存到当前实例的本机资料。'}>
        {connected ? <>
          {dirty && <button className="button secondary" type="button" disabled={readOnly} onClick={() => editor?.discardDraft()}>放弃草稿</button>}
          <button className="button primary" type="button" disabled={!canSave} onClick={() => { void editor?.save(); }}>保存身份</button>
        </> : <DisabledAction primary>保存身份</DisabledAction>}
      </InlineFooter>}
    </Panel>
      <Panel title="资料用途">{editor && snapshot?.identity ?
        <ChatShareControl key={`${snapshot.petID}:${snapshot.revision}`} enabled={snapshot.identity.chatShare === true}
          locked={!!busy || !!review || inspecting !== undefined} canGrant={!dirty}
          scope="授权当前保存的名称、身份定位、性格、表达方式和边界" onChange={value => { void editor.setChatShare(value); }} /> :
        <p className="module-copy">保存身份后可单独授权在线文字聊天。</p>}
      </Panel>
      <Disclosure title="版本历史">{snapshot?.identityHistory.length
        ? [...snapshot.identityHistory].reverse().map(item => <OptionRow key={item.revision} title={`${item.name} · 版本 ${item.revision}`} detail={item.updatedAt.slice(0, 10)}>
          <button className="button secondary" type="button" disabled={!!busy || !!review || inspecting === item.revision} onClick={() => editor?.inspectHistory(item.revision)}>查看版本 {item.revision}</button>
        </OptionRow>)
        : <EmptyState title={snapshot ? '暂无历史版本' : '尚未读取版本'} detail={connected ? '这里显示当前实例保存过的身份版本。' : '接入角色资料后，可在这里查看修订和恢复旧版本。'} />}</Disclosure>
  </ModulePage>;
}
