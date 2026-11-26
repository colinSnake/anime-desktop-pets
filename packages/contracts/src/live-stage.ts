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
export const liveActions = {
  '01': { label: '打招呼', line: '嗨，我是龙妹，欢迎来直播间！' },
  '18': { label: '开心一下', line: '今天也要开开心心！' },
  '20': { label: '比个心', line: '给你比个心～' },
} as const;
export type LiveAction = keyof typeof liveActions;
export const liveActionIds = ['01', '18', '20'] as const satisfies readonly LiveAction[];
export type LivePlacement = { position: number; scale: number };
export type LiveProfile = { schemaVersion: 2; selected: LiveScene; scenes: Record<LiveScene, LivePlacement> };
export const defaultLiveProfile = (): LiveProfile => ({ schemaVersion: 2, selected: 'desk-room', scenes: {
  'desk-room': { position: 50, scale: 100 }, 'rain-loft': { position: 50, scale: 100 }, 'cloud-terrace': { position: 50, scale: 100 },
  meadow: { position: 48, scale: 100 }, forest: { position: 47, scale: 100 }, studio: { position: 47, scale: 100 },
} });
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
export function isLiveProfile(value: unknown): value is LiveProfile {
  if (!fields(value, ['schemaVersion', 'selected', 'scenes']) || value.schemaVersion !== 2 || !isLiveScene(value.selected)) return false;
  const scenes = value.scenes;
  return fields(scenes, liveScenes.map(scene => scene.id)) && liveScenes.every(scene => isLivePlacement(scenes[scene.id], scene.id));
}
export const liveMethods = ['read', 'save', 'switchScene', 'start', 'stop', 'preview', 'copy', 'trigger', 'submitDanmaku', 'stopDanmaku'] as const;
export type LiveMethod = typeof liveMethods[number];
export const liveChannel = (method: LiveMethod) => `pet:live-stage-${method}`;
export function validLiveArgs(method: LiveMethod, args: unknown[]): boolean {
  if (method === 'save') return args.length === 1 && isLiveProfile(args[0]);
  if (method === 'switchScene') return args.length === 1 && isLiveScene(args[0]);
  if (method === 'submitDanmaku') return args.length === 1 && isLiveDanmaku(args[0]);
  if (method === 'trigger') return args.length === 1 && isLiveAction(args[0]);
  return args.length === 0;
}
export type LiveError = 'unavailable' | 'storage' | 'migration' | 'busy' | 'media';
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
  read(): Promise<LiveResult>;
  save(profile: LiveProfile): Promise<LiveResult>;
  switchScene(scene: LiveScene): Promise<LiveResult>;
  start(): Promise<LiveResult>;
  stop(): Promise<LiveResult>;
  preview(): Promise<LiveResult>;
  copy(): Promise<LiveResult>;
  trigger(action: LiveAction): Promise<LiveResult>;
  submitDanmaku?(text: string): Promise<LiveResult>;
  stopDanmaku?(): Promise<LiveResult>;
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
