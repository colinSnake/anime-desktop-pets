import { definition, object, shape, type PetDefinition, type PetPreferences } from '../../../packages/contracts/src/pets.ts';
export type PetRegistry = { schemaVersion: 1; instances: PetDefinition[] };
export const defaultPreferences = (): PetPreferences => ({ size: 256, scheduledActivity: true, movement: true, hideInFullscreen: true });
/** 仅对显式传入的数据解码；本函数不发现/访问旧用户资料。 */
export function decodeRegistry(value: unknown): PetRegistry {
  if (!shape(value, ['schemaVersion', 'instances']) || value.schemaVersion !== 1 || !Array.isArray(value.instances) || value.instances.length > 32) throw new Error('invalid_registry');
  const instances = value.instances.map(raw => {
    if (!shape(raw, ['id', 'package', 'displayName', 'enabled', 'autoStartOnLaunch', 'preferences'])) throw new Error('invalid_registry');
    const prefs = raw.preferences === undefined ? {} : raw.preferences;
    if (!object(prefs)) throw new Error('invalid_registry');
    const p = { ...defaultPreferences(), ...prefs };
    if (!Number.isInteger(p.size) || p.size < 96 || p.size > 512) throw new Error('invalid_registry');
    p.size = Math.max(128, Math.min(384, p.size));
    if (p.x === null && p.y === null) { delete p.x; delete p.y; }
    const row = { ...raw, enabled: raw.enabled === undefined ? true : raw.enabled, autoStartOnLaunch: raw.autoStartOnLaunch === undefined ? !/(?:-copy(?:-[0-9]+)?)+$/.test(String(raw.id)) : raw.autoStartOnLaunch, preferences: p };
    if (!definition(row)) throw new Error('invalid_registry');
    return row;
  });
  if (new Set(instances.map(row => row.id)).size !== instances.length) throw new Error('invalid_registry');
  return { schemaVersion: 1, instances };
}
