import { useRef, type ReactNode } from 'react';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { InteractionCardHeading, InteractionHero, InteractionLayout } from './InteractionLayout.tsx';
import { patch, type Draft } from './WorkspacePanels.tsx';

const platforms = [{ value: 'bilibili', label: 'B 站' }, { value: 'douyin', label: '抖音' }] as const;
const capabilities = [{ icon: 'lock', text: '平台授权' }, { icon: 'live', text: '连接直播间' }, { icon: 'chat', text: '收发弹幕' }] as const;
type Platform = typeof platforms[number]['value'];
type LiveDraft = { platform: Platform; rooms: Record<Platform, string> };
export const emptyLive: LiveDraft = { platform: 'bilibili', rooms: { bilibili: '', douyin: '' } };

export function LivePage({ draft, appearance }: { draft: Draft<LiveDraft>; appearance?: ReactNode }) {
  const { platform, rooms } = draft.value;
  const room = rooms[platform];
  const roomInput = useRef<HTMLInputElement>(null);
  const platformName = platforms.find(item => item.value === platform)!.label;
  const updateRoom = (value: string) => draft.update(previous => ({ ...previous, rooms: { ...previous.rooms, [platform]: value } }));

  return <InteractionLayout page="live" title="直播管理" description="分别整理 B 站与抖音的房间草稿。" appearance={appearance}>
    <InteractionHero page="live" eyebrow="平台连接" title="平台尚未接入" description="可以先整理房间标识，编辑草稿不会连接直播间。">
      <span className="interaction-pill dot">仅支持草稿</span>
    </InteractionHero>
    <div className="interaction-live-layout">
      <section className="interaction-card" aria-labelledby="live-room-title">
        <InteractionCardHeading id="live-room-title" title="房间草稿" description="两个平台各自保留填写内容。" context="仅当前窗口" />
        <div className="interaction-room-body">
          <fieldset className="interaction-platforms"><legend className="sr-only">直播平台</legend>
            {platforms.map(({ value, label }) => {
              const filled = !!rooms[value].trim();
              return <label key={value}>
                <input type="radio" name="live-platform" value={value} checked={platform === value} onChange={() => patch(draft, { platform: value })}
                  aria-label={filled ? `${label}，已有草稿` : label} />
                <span>{label}{filled && <i aria-hidden="true" />}</span>
              </label>;
            })}
          </fieldset>
          <label className="interaction-field-label" htmlFor="live-room-id">直播间号或房间标识</label>
          <input ref={roomInput} className="interaction-field" id="live-room-id" type="text" maxLength={160} autoComplete="off" spellCheck={false} aria-describedby="live-room-hint"
            placeholder={`填写${platformName}房间标识`} value={room} onChange={event => updateRoom(event.currentTarget.value)} />
          <p className="interaction-field-hint" id="live-room-hint">关闭工作区后清空，不会保存到磁盘。</p>
        </div>
        <div className="interaction-card-footer room-footer">
          <span><PetNookIcon name="lock" /><span aria-live="polite">{room.trim() ? '已填写草稿 · 未连接' : '当前平台还没有填写内容'}</span></span>
          {room && <button className="interaction-button quiet" type="button" onClick={() => { updateRoom(''); roomInput.current?.focus(); }}>清空当前草稿</button>}
        </div>
      </section>
      <section className="interaction-card" aria-labelledby="live-capability-title">
        <InteractionCardHeading id="live-capability-title" title="平台能力" description="待接入后才会开放。" />
        <ul className="interaction-capabilities">{capabilities.map(({ icon, text }) =>
          <li key={text}><span><PetNookIcon name={icon} />{text}</span><span className="interaction-pill muted">未接入</span></li>
        )}</ul>
      </section>
    </div>
  </InteractionLayout>;
}
