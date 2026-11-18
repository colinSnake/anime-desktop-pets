import { Choice, DisabledAction, EmptyState, Field, InlineFooter, ModulePage, OptionRow, Panel, PreviewNotice, Split, patch, type Draft } from './WorkspacePanels.tsx';

const platforms = [{ value: 'bilibili', label: 'B 站' }, { value: 'douyin', label: '抖音' }] as const;
type Platform = typeof platforms[number]['value'];
type LiveDraft = { platform: Platform; rooms: Record<Platform, string> };
export const emptyLive: LiveDraft = { platform: 'bilibili', rooms: { bilibili: '', douyin: '' } };

export function LivePage({ draft }: { draft: Draft<LiveDraft> }) {
  const { platform, rooms } = draft.value;
  const platformName = platforms.find(item => item.value === platform)!.label;
  return <ModulePage title="直播管理" description="按平台整理房间配置，并查看弹幕和互动的连接状态。">
    <PreviewNotice>可以试填房间草稿。平台连接尚未接入，不会登录账号或发送请求。</PreviewNotice>
    <Split main={<Panel title="房间配置">
      <div className="module-stack">
        <Choice label="直播平台" value={platform} options={platforms} onChange={next => patch(draft, { platform: next })} />
        <Field label="直播间号或房间标识" placeholder={`填写${platformName}房间标识`} limit={160} value={rooms[platform]} onChange={value => draft.update(previous => ({ ...previous, rooms: { ...previous.rooms, [platform]: value } }))} />
      </div>
      <InlineFooter hint="两个平台分别保留草稿。"><DisabledAction primary>保存直播设置</DisabledAction></InlineFooter>
    </Panel>} aside={<>
      <Panel title="连接状态"><OptionRow title={platformName} detail="平台尚未接入。"><span className="badge">未连接</span></OptionRow><div className="module-actions module-inset"><DisabledAction>连接直播间</DisabledAction><DisabledAction>平台授权</DisabledAction></div></Panel>
      <Panel title="弹幕与互动"><EmptyState title="尚未读取直播消息" detail="当前不接收弹幕、不发送消息，也不会触发表情或动作。" /></Panel>
    </>} />
  </ModulePage>;
}
