/** Fixed values shared by the management surface and the isolated stage. */
export const liveScenes = [
  { id: 'desk-room', name: '暮色小屋', detail: '月窗、暖灯和木桌', positionMin: 25, positionMax: 75, floorY: 900 },
  { id: 'rain-loft', name: '雨夜阁楼', detail: '雨窗、星图和提灯', positionMin: 25, positionMax: 75, floorY: 900 },
  { id: 'cloud-terrace', name: '云海露台', detail: '远山、层云和暖阳', positionMin: 25, positionMax: 75, floorY: 900 },
  { id: 'meadow', name: '蓝天草原', detail: '晴空、草甸和花径', positionMin: 25, positionMax: 75, floorY: 850 },
  { id: 'forest', name: '森林篝火', detail: '星月、松林和篝火', positionMin: 25, positionMax: 55, floorY: 850 },
  { id: 'studio', name: '录音棚', detail: '声波墙、唱片和演播毯', positionMin: 25, positionMax: 75, floorY: 850 },
] as const;
export type LiveScene = typeof liveScenes[number]['id'];
export const liveRoleIds = ['longmei', 'dafeiyu'] as const;
export type LiveRoleId = typeof liveRoleIds[number];
export const isLiveRoleId = (value: unknown): value is LiveRoleId => typeof value === 'string' && liveRoleIds.includes(value as LiveRoleId);

export type LiveBindingSnapshot={revision:number;bindings:Record<LiveRoleId,string|null>};
export type LiveBindingInput={expectedRevision:number;role:LiveRoleId;petID:string|null};
export type LiveBindingResult={ok:true;revision:number;bindings:Record<LiveRoleId,string|null>}|{ok:false;error:'unavailable'|'invalid'|'conflict'};
export const isLiveBindingInput=(v:unknown):v is LiveBindingInput=>fields(v,['expectedRevision','role','petID'])&&Number.isSafeInteger(v.expectedRevision)&&Number(v.expectedRevision)>=0&&isLiveRoleId(v.role)&&(v.petID===null||(typeof v.petID==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.petID)));
export function isLiveBindingResult(v:unknown):v is LiveBindingResult {
 if(!v||typeof v!=='object'||Array.isArray(v))return false;const r=v as Record<string,unknown>;
 if(r.ok===false)return Object.keys(r).length===2&&['unavailable','invalid','conflict'].includes(String(r.error));
 if(r.ok!==true||!Number.isSafeInteger(r.revision)||Number(r.revision)<0||!r.bindings||typeof r.bindings!=='object'||Array.isArray(r.bindings))return false;
 const b=r.bindings as Record<string,unknown>;return Object.keys(b).length===2&&Object.keys(b).every(isLiveRoleId)&&liveRoleIds.every(id=>b[id]===null||(typeof b[id]==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(b[id] as string)));
}
export const liveActions = {
  '01': { label: '打招呼', line: '嗨，我是龙妹，欢迎来直播间！' },
  '18': { label: '开心一下', line: '今天也要开开心心！' },
  '20': { label: '比个心', line: '给你比个心～' },
} as const;
export const liveRoleActions = {
  longmei: liveActions,
  dafeiyu: {
    'companion-wave': { label: '打招呼', line: '嗨，我是鲸鱼妹，欢迎来直播间！' },
    'companion-jump': { label: '开心回应', line: '见到你们，我很开心！' },
    'companion-49c0d89c0992': { label: '鲸尾回应', line: '给大家拍个鲸鱼尾巴～' },
  },
} as const satisfies Record<LiveRoleId, Readonly<Record<string, { label: string; line: string }>>>;
export type LiveRoleActionId<R extends LiveRoleId = LiveRoleId> = keyof typeof liveRoleActions[R] & string;
export function isLiveRoleAction(role: unknown, action: unknown): role is LiveRoleId {
  return isLiveRoleId(role) && typeof action === 'string' && Object.hasOwn(liveRoleActions[role], action);
}
export type LiveAction = keyof typeof liveActions;
export const liveActionIds = ['01', '18', '20'] as const satisfies readonly LiveAction[];
export type LivePlacement = { position: number; scale: number };
export type LiveRoleProfile = { schemaVersion: 3; selected: LiveScene; scenes: Record<LiveScene, LivePlacement> };
export type LiveProfile = LiveRoleProfile;
export type StoredLiveProfile = { schemaVersion: 3; selected: LiveScene; roles: Record<LiveRoleId, { scenes: Record<LiveScene, LivePlacement> }> };
export const defaultRoleProfile = (): LiveRoleProfile => ({ schemaVersion: 3, selected: 'desk-room', scenes: {
  'desk-room': { position: 50, scale: 100 }, 'rain-loft': { position: 50, scale: 100 }, 'cloud-terrace': { position: 50, scale: 100 },
  meadow: { position: 48, scale: 100 }, forest: { position: 47, scale: 100 }, studio: { position: 47, scale: 100 },
} });
export const defaultLiveProfile = (): LiveProfile => defaultRoleProfile();
const validInt = (n: unknown, low: number, high: number) => typeof n === 'number' && Number.isInteger(n) && n >= low && n <= high;
function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function isLiveScene(value: unknown): value is LiveScene { return liveScenes.some(scene => scene.id === value); }
export function isLiveAction(value: unknown): value is LiveAction { return typeof value === 'string' && Object.hasOwn(liveActions, value); }
export function isLivePlacement(value: unknown, scene?: LiveScene): value is LivePlacement {
  const bounds = scene ? liveScenes.find(item => item.id === scene) : undefined;
  return fields(value, ['position', 'scale']) && validInt(value.position, bounds?.positionMin ?? 25, bounds?.positionMax ?? 75) && validInt(value.scale, 75, 125);
}
export function isLiveRoleProfile(value: unknown): value is LiveRoleProfile {
  if (!fields(value, ['schemaVersion', 'selected', 'scenes']) || value.schemaVersion !== 3 || !isLiveScene(value.selected)) return false;
  const scenes = value.scenes;
  return fields(scenes, liveScenes.map(scene => scene.id)) && liveScenes.every(scene => isLivePlacement(scenes[scene.id], scene.id));
}
export function isLiveProfile(value: unknown): value is LiveProfile { return isLiveRoleProfile(value); }
export function isStoredLiveProfile(value: unknown): value is StoredLiveProfile {
  return fields(value, ['schemaVersion', 'selected', 'roles']) && value.schemaVersion === 3 && isLiveScene(value.selected) &&
    fields(value.roles, ['longmei', 'dafeiyu']) && liveRoleIds.every(role => { const roles = value.roles as Record<string, unknown>; const row = roles[role]; if (!fields(row, ['scenes'])) return false; const scenes = row.scenes; return fields(scenes, liveScenes.map(scene => scene.id)) && liveScenes.every(scene => isLivePlacement(scenes[scene.id], scene.id)); });
}
export const liveMethods = ['read', 'save', 'switchScene', 'start', 'stop', 'preview', 'copy', 'trigger', 'submitDanmaku', 'stopDanmaku'] as const;
export type LiveMethod = typeof liveMethods[number];
export const liveChannel = (method: LiveMethod) => `pet:live-stage-${method}`;
export function validLiveArgs(method: LiveMethod, args: unknown[]): boolean {
  const role=args.at(-1);
  if(!isLiveRoleId(role))return false;
  if(method==='save')return args.length===2&&isLiveProfile(args[0]);
  if(method==='switchScene')return args.length===2&&isLiveScene(args[0]);
  if(method==='submitDanmaku')return args.length===2&&isLiveDanmaku(args[0]);
  if(method==='trigger')return args.length===2&&isLiveRoleAction(role,args[0]);
  return args.length===1;
}

export type LiveError = 'unavailable' | 'storage' | 'migration' | 'busy' | 'media' | 'unbound' | 'role-mismatch';
export type LiveProfileResult = { ok: true; profile: LiveProfile } | { ok: false; error: LiveError };
export type LiveVoiceState = 'muted' | 'preparing' | 'ready' | 'reference-required' | 'voice-busy' | 'voice-failed';
export const liveDanmakuMaxLength = 120;
function isSingleLine(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !!value && value === value.trim() &&
    !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value);
}
export const isLiveDanmaku = (value: unknown): value is string => isSingleLine(value, liveDanmakuMaxLength);
export const isLiveDanmakuReply = (value: unknown): value is string => {
  if (!isSingleLine(value, 56)) return false;
  // The shared subtitle and TTS input is plain, speakable text, not markup or a URL.
  return !/[<>`*_#\[\]{}]|(?:https?:|www\.)/iu.test(value);
};
export type LiveDanmakuError = 'no-model' | 'model-failed' | 'rate-limit' | 'speech-failed';
export type LiveDanmakuState = {phase:'generating' | 'synthesizing' | 'stopped'} |
  {phase:'published';text:string} | {phase:'failed';error:LiveDanmakuError};
export type LiveResult = { ok: true; profile: LiveProfile; running: boolean; voice?: LiveVoiceState; danmaku?: LiveDanmakuState } | { ok: false; error: LiveError };
export interface LiveStageBridge {
  read(role:LiveRoleId): Promise<LiveResult>;
  save(profile: LiveProfile,role:LiveRoleId): Promise<LiveResult>;
  switchScene(scene: LiveScene,role:LiveRoleId): Promise<LiveResult>;
  start(role:LiveRoleId): Promise<LiveResult>;
  stop(role:LiveRoleId): Promise<LiveResult>;
  preview(role:LiveRoleId): Promise<LiveResult>;
  copy(role:LiveRoleId): Promise<LiveResult>;
  trigger(action: LiveRoleActionId,role:LiveRoleId): Promise<LiveResult>;
  submitDanmaku?(text: string,role:LiveRoleId): Promise<LiveResult>;
  stopDanmaku?(role:LiveRoleId): Promise<LiveResult>;
  readBindings?():Promise<LiveBindingResult>;
  writeBinding?(input:LiveBindingInput):Promise<LiveBindingResult>;
}
export type LiveSnapshot = { protocol: 1; scene: LiveScene; placement: LivePlacement; generation: number; action?: LiveAction; remainingMs?: number; voice?: true; reply?: string };
export const liveActionLifetimeMs = 7300; // The pinned four-second clips plus bounded first-frame preparation.
export const liveVoiceMaxMs = 8_000;
export const liveVoiceStartBudgetMs = 4_000;
export function isLiveSnapshot(value: unknown): value is LiveSnapshot {
  if (!(fields(value, ['protocol', 'scene', 'placement', 'generation']) || fields(value, ['protocol', 'scene', 'placement', 'generation', 'action', 'remainingMs']) || fields(value, ['protocol', 'scene', 'placement', 'generation', 'action', 'remainingMs', 'voice']) || fields(value, ['protocol', 'scene', 'placement', 'generation', 'action', 'remainingMs', 'voice', 'reply']))) return false;
  return value.protocol === 1 && isLiveScene(value.scene) && isLivePlacement(value.placement, value.scene) && validInt(value.generation, 0, Number.MAX_SAFE_INTEGER) &&
    (!Object.hasOwn(value, 'voice') || value.voice === true) &&
    (!Object.hasOwn(value, 'reply') || (value.action === '01' && value.voice === true && isLiveDanmakuReply(value.reply))) &&
    (!Object.hasOwn(value, 'action') || (isLiveAction(value.action) && validInt(value.remainingMs, 1, liveVoiceMaxMs + liveVoiceStartBudgetMs)));
}
