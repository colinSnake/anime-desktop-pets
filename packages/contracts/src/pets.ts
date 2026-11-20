/** 配置契约：不含素材路径、进程标识、凭证或通用命令。 */
export type Theme = 'system' | 'light' | 'dark';
export type PackageReference = { id: string; version: string };
export type PetPreferences = { size: number; x?: number; y?: number; scheduledActivity: boolean; movement: boolean; hideInFullscreen: boolean };
export type PetDefinition = { id: string; package: PackageReference; displayName?: string; enabled: boolean; autoStartOnLaunch: boolean; preferences: PetPreferences };
export type PetPhase = 'not-connected' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type CatalogEntry = PackageReference & { name: string; launchable?: boolean };
export type PackageImportResult = { ok: true; items: { name: string; status: 'added' | 'failed'; package?: PackageReference }[] } | { ok: false; error: PetError };
export type AppliedDisplayPreferences = { size: number; hideInFullscreen: boolean; visible: boolean };
export type BehaviorPreferences = Pick<PetPreferences, 'scheduledActivity' | 'movement'>;
export type RuntimeBehaviorState = ({ status: 'applied' } & BehaviorPreferences) | { status: 'failed' };
export type RuntimeMenuFeedback = 'apply-failed' | 'save-failed' | 'rollback-failed';
export type RuntimePositionFeedback = { x: number; y: number; status: 'saving' | 'saved' | 'failed' };
export type LinkageState = 'active' | 'pausing' | 'paused' | 'stop-unconfirmed';
export type WorkspaceData = { playerMode?: 'video'; revision: number; theme: Theme; catalog: CatalogEntry[]; instances: (PetDefinition & { phase: PetPhase; applied?: AppliedDisplayPreferences; behavior?: RuntimeBehaviorState; positionFeedback?: RuntimePositionFeedback; menuFeedback?: RuntimeMenuFeedback })[]; maximumRunning: 3; linkage: LinkageState };
export const PET_ERRORS = ['unavailable', 'invalid', 'conflict', 'not-found', 'limit', 'active', 'busy', 'storage', 'package-unavailable', 'apply-failed'] as const;
export type PetError = typeof PET_ERRORS[number];
export type PetResult = { ok: true; workspace: WorkspaceData } | { ok: false; error: PetError };
type Versioned = { expectedRevision: number };
export type PetInputs = {
  add: Versioned & { package: PackageReference };
  start: Versioned & { id: string };
  stop: Versioned & { id: string };
  applyDisplay: Versioned & { id: string };
  applyBehavior: Versioned & { id: string };
  visibility: Versioned & { id: string; visible: boolean };
  clone: Versioned & { id: string };
  delete: Versioned & { id: string };
  save: Versioned & { id: string; displayName: string; enabled: boolean; autoStartOnLaunch: boolean; preferences: PetPreferences };
  theme: Versioned & { theme: Theme };
  pause: Versioned;
  resume: Versioned;
};
export type PetAction = keyof PetInputs;
export interface PetsBridge {
  list(): Promise<PetResult>;
  importPackages(): Promise<PackageImportResult>;
  start(input: PetInputs['start']): Promise<PetResult>;
  stop(input: PetInputs['stop']): Promise<PetResult>;
  applyDisplayPreferences(input: PetInputs['applyDisplay']): Promise<PetResult>;
  applyBehaviorPreferences(input: PetInputs['applyBehavior']): Promise<PetResult>;
  setVisible(input: PetInputs['visibility']): Promise<PetResult>;
  add(input: PetInputs['add']): Promise<PetResult>;
  clone(input: PetInputs['clone']): Promise<PetResult>;
  delete(input: PetInputs['delete']): Promise<PetResult>;
  save(input: PetInputs['save']): Promise<PetResult>;
  setTheme(input: PetInputs['theme']): Promise<PetResult>;
  pause(input: PetInputs['pause']): Promise<PetResult>;
  resume(input: PetInputs['resume']): Promise<PetResult>;
}
export const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const shape = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => object(v) && Object.keys(v).every(k => keys.includes(k));
export const revision = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER;
export const theme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';
export const petId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
export const petName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && [...v].length <= 80 && !/[\x00-\x1f\x7f-\x9f]/.test(v);
export function packageReference(v: unknown): v is PackageReference {
  return shape(v, ['id', 'version']) && typeof v.id === 'string' && v.id.length <= 100 && /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(v.id) && typeof v.version === 'string' && v.version.length <= 64 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v.version);
}
export function preferences(v: unknown): v is PetPreferences {
  return shape(v, ['size', 'x', 'y', 'scheduledActivity', 'movement', 'hideInFullscreen']) && Number.isInteger(v.size) && Number(v.size) >= 128 && Number(v.size) <= 384 && ['scheduledActivity', 'movement', 'hideInFullscreen'].every(k => typeof v[k] === 'boolean') && ((v.x === undefined && v.y === undefined) || [v.x, v.y].every(n => Number.isSafeInteger(n) && Math.abs(Number(n)) <= 1_000_000));
}
export function definition(v: unknown): v is PetDefinition {
  return shape(v, ['id', 'package', 'displayName', 'enabled', 'autoStartOnLaunch', 'preferences']) && petId(v.id) && packageReference(v.package) && (v.displayName === undefined || petName(v.displayName)) && typeof v.enabled === 'boolean' && typeof v.autoStartOnLaunch === 'boolean' && preferences(v.preferences);
}
export function isPetInput<A extends PetAction>(action: A, input: unknown): input is PetInputs[A] {
  if (!object(input) || !revision(input.expectedRevision)) return false;
  switch (action) {
    case 'pause': case 'resume': return shape(input, ['expectedRevision']);
    case 'add': return shape(input, ['expectedRevision', 'package']) && packageReference(input.package);
    case 'start': case 'stop': case 'applyDisplay': case 'applyBehavior': case 'clone': case 'delete': return shape(input, ['expectedRevision', 'id']) && petId(input.id);
    case 'visibility': return shape(input, ['expectedRevision', 'id', 'visible']) && petId(input.id) && typeof input.visible === 'boolean';
    case 'theme': return shape(input, ['expectedRevision', 'theme']) && theme(input.theme);
    case 'save': return shape(input, ['expectedRevision', 'id', 'displayName', 'enabled', 'autoStartOnLaunch', 'preferences']) && petId(input.id) && petName(input.displayName) && typeof input.enabled === 'boolean' && typeof input.autoStartOnLaunch === 'boolean' && preferences(input.preferences);
    default: return false;
  }
}
export function catalogEntry(v: unknown): v is CatalogEntry {
  return shape(v, ['id', 'version', 'name', 'launchable']) && packageReference(object(v) ? { id: v.id, version: v.version } : null) && petName(v.name) && (v.launchable === undefined || typeof v.launchable === 'boolean');
}
export function isPackageImportResult(v: unknown): v is PackageImportResult {
  if (!object(v)) return false;
  if (v.ok === false) return shape(v, ['ok', 'error']) && PET_ERRORS.includes(v.error as PetError);
  return v.ok === true && shape(v, ['ok', 'items']) && Array.isArray(v.items) && v.items.length <= 16 && v.items.every(item =>
    shape(item, ['name', 'status', 'package']) && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 255 &&
    item.name !== '.' && item.name !== '..' && !/[\\/\x00-\x1f\x7f-\x9f]/.test(item.name) &&
    (item.status === 'failed' ? item.package === undefined : item.status === 'added' && packageReference(item.package)));
}
export function isWorkspaceData(v: unknown): v is WorkspaceData {
  return shape(v, ['revision', 'theme', 'catalog', 'instances', 'maximumRunning', 'linkage', 'playerMode']) && (v.playerMode === undefined || v.playerMode === 'video') && revision(v.revision) && theme(v.theme) && v.maximumRunning === 3 && ['active', 'pausing', 'paused', 'stop-unconfirmed'].includes(String(v.linkage)) && Array.isArray(v.catalog) && v.catalog.length <= 32 && v.catalog.every(catalogEntry) && new Set(v.catalog.map(c => `${c.id}@${c.version}`)).size === v.catalog.length && Array.isArray(v.instances) && v.instances.length <= 32 && v.instances.every(row => {
    if (!shape(row, ['id', 'package', 'displayName', 'enabled', 'autoStartOnLaunch', 'preferences', 'phase', 'applied', 'behavior', 'positionFeedback', 'menuFeedback'])) return false;
    const { phase, applied, behavior, positionFeedback, menuFeedback, ...d } = row;
    return definition(d) && typeof phase === 'string' && ['not-connected', 'stopped', 'starting', 'running', 'stopping', 'failed'].includes(phase) &&
      (applied === undefined || (shape(applied, ['size', 'hideInFullscreen', 'visible']) && Number.isInteger(applied.size) && Number(applied.size) >= 128 && Number(applied.size) <= 384 && typeof applied.hideInFullscreen === 'boolean' && typeof applied.visible === 'boolean')) &&
      (behavior === undefined || (shape(behavior, ['status']) && behavior.status === 'failed') ||
        (shape(behavior, ['status', 'scheduledActivity', 'movement']) && behavior.status === 'applied' && typeof behavior.scheduledActivity === 'boolean' && typeof behavior.movement === 'boolean')) &&
      (menuFeedback === undefined || menuFeedback === 'apply-failed' || menuFeedback === 'save-failed' || menuFeedback === 'rollback-failed') &&
      (positionFeedback === undefined || (shape(positionFeedback, ['x', 'y', 'status']) && Number.isSafeInteger(positionFeedback.x) && Number.isSafeInteger(positionFeedback.y) && Math.abs(Number(positionFeedback.x)) <= 1_000_000 && Math.abs(Number(positionFeedback.y)) <= 1_000_000 && typeof positionFeedback.status === 'string' && ['saving', 'saved', 'failed'].includes(positionFeedback.status)));
  }) && new Set(v.instances.map(row => row.id)).size === v.instances.length;
}
export function isPetResult(v: unknown): v is PetResult {
  return object(v) && (v.ok === true ? shape(v, ['ok', 'workspace']) && isWorkspaceData(v.workspace) : v.ok === false && shape(v, ['ok', 'error']) && PET_ERRORS.includes(v.error as PetError));
}
