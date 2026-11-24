import type { MenuItemConstructorOptions as Item } from 'electron';
import { videoSizePresets, type VideoMenuIntent } from '../../../app-service/src/workspace-video-protocol.ts';
import { activityIdles, activityVariants } from './activity-schedule';
import { companionDaily, companionTravel, moveFacing, movements, type Movement } from './locomotion';
import type { Clip, CompanionClip } from './playback';
import companionMedia from '../../../../config/local-companion-media.json';

// Labels from the pinned v0.5.1 asset manifest used by the historical macOS menu.
const interaction = ['招手/打招呼', '灵感', '得意', '贴贴', '傲娇', '小生气', '困倦', '偷吃', '庆祝', '比心', '龙族契约', '眷属印记', '宝藏收藏', '幼龙吐息', '逆鳞信任'];
const work = { work: '收到任务', work02: '处理任务', work03: '整理归档文件', work04: '翻阅工作资料', work05: '放大镜查看细节' } as const;
const idle = ['默认待机', '待机动作2', '翻绘本', '贴贴枕头', '玩掌机', '贴尾巴'];
const travel: Record<Movement, string> = {
  move02: '跑步（向右）', move02left: '跑步（向左）', move01left: '走路（向左）', move01right: '走路（向右）', move03left: '飞行（向左）', move03right: '飞行（向右）',
};

type State = { size: number; hideInFullscreen: boolean; scheduledActivity: boolean; movement: boolean;
  protectedPose: boolean; settling?: boolean; reduced: boolean; task: boolean; quota: boolean; companionRole?: boolean; companionClips?: readonly CompanionClip[] };
type Actions = { intent(intent: VideoMenuIntent): void; pose(clip: Clip): void; travel(move: Movement): void;
  perform(): void; idle(): void; quota(): void; stop(): void };

export function canPreviewPetMotion(gate: { visible: boolean; reduced: boolean; interaction: boolean; task: boolean }, movement: boolean) {
  return gate.visible && !gate.reduced && !gate.interaction && (!movement || !gate.task);
}

export function workspacePetMenu(state: State, actions: Actions): Item[] {
  const blocked = state.protectedPose && !state.settling;
  const motion = canPreviewPetMotion({ ...state, visible: true, interaction: blocked }, false);
  const toggle = (label: string, kind: 'hideInFullscreen' | 'scheduledActivity' | 'movement'): Item => ({
    label, type: 'checkbox', checked: state[kind], click: () => actions.intent({ kind, value: !state[kind] }),
  });
  const pose = (clip: Clip, label: string): Item => ({ label, click: () => actions.pose(clip) });
  const groups = new Map<string, Item[]>();
  if (state.companionRole && state.companionClips?.length) {
    for (const [clip, { group, label }] of Object.entries(companionMedia.actions) as [CompanionClip, { group: string; label: string }][]) {
      if (!state.companionClips.includes(clip)) continue;
      const submenu = groups.get(group) ?? [];
      submenu.push(pose(clip, label));
      groups.set(group, submenu);
    }
  }
  const has = (clip: CompanionClip) => state.companionClips?.includes(clip) === true;
  const directions = movements.flatMap(move => {
    const profile = companionTravel[move];
    if (state.companionRole && !has(profile.file)) return [];
    const label = state.companionRole ? `${profile.label}（向${moveFacing(move) === 'left' ? '左' : '右'}）` : travel[move];
    return [{ label, click: () => actions.travel(move) }];
  });
  const activity: Item = { label: '自主活动', submenu: [
    toggle('定时播放动作', 'scheduledActivity'), toggle('允许蹦跳移动', 'movement'),
    ...(!state.companionRole || companionDaily.some(has) ? [{ label: state.companionRole ? '播放一个日常动作' : '表演一套动作',
      enabled: motion, click: actions.perform }] : []),
    ...(directions.length ? [{ label: state.companionRole ? '走路 / 跑步 / 漂浮' : '走路 / 跑步 / 飞行',
      enabled: motion && !state.task, submenu: directions }] : []),
  ] };
  const mediaActions = Array.from(groups, ([label, submenu]) => ({ label, submenu }));
  return [
    { label: '隐藏桌宠', click: () => actions.intent({ kind: 'hide' }) },
    toggle('全屏时自动隐藏', 'hideInFullscreen'),
    ...(state.settling ? [{ label: '回弹中，动作和尺寸稍后执行', enabled: false }] : []),
    { label: '桌宠大小', enabled: !blocked, submenu: videoSizePresets.map(value => ({
      label: `${value / 256 * 100}%（${value} × ${value}）`, type: 'checkbox', checked: state.size === value,
      click: () => actions.intent({ kind: 'size', value }),
    })) },
    ...(state.quota ? [{ label: '查询额度', enabled: !blocked, click: actions.quota }] : []),
    { type: 'separator' },
    activity,
    ...(state.companionRole ? [
    ...(mediaActions.length ? [{ label: '动作预览', enabled: motion, submenu: mediaActions }] : []),
    { label: '回到待机', enabled: !blocked, click: actions.idle }] : [
    { label: '动作预览', enabled: motion, submenu: [
      { label: '互动差分动画', submenu: activityVariants.map((clip, i) => pose(clip, interaction[i]!)) },
      { label: '工作差分动画', submenu: (Object.keys(work) as (keyof typeof work)[]).map(clip => pose(clip, work[clip])) },
      { label: '待机差分动画', submenu: activityIdles.map((clip, i) => pose(clip, idle[i]!)) },
    ] },
    { label: '回到待机', enabled: !blocked, click: actions.idle }]),
    { type: 'separator' },
    { label: '停止该桌宠', click: actions.stop },
  ];
}
