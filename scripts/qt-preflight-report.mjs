/** 严格枚举重建输出，拒绝启动钩子文本或解释器返回的任意字段。 */
const checkIds = ['python-3.10', 'pyside6', 'pillow', 'adapter-sources', 'legacy-ipc-platform'];
const baseWarnings = ['player-not-integrated', 'desktop-matrix-unverified', 'native-libraries-and-assets-unverified'];
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function safeQtReport(text, exitCode) {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) return;
    const value = JSON.parse(text);
    if (!exactKeys(value, ['protocolVersion', 'kind', 'status', 'platform', 'checks', 'warnings', 'nativeModulesImported', 'desktopStarted', 'playerIntegrated'])
      || value.protocolVersion !== 1 || value.kind !== 'qt-preflight'
      || value.nativeModulesImported !== false || value.desktopStarted !== false || value.playerIntegrated !== false
      || !exactKeys(value.platform, ['os', 'session'])
      || !['macos', 'windows', 'linux', 'unsupported'].includes(value.platform.os)
      || !['native', 'x11', 'wayland', 'unknown'].includes(value.platform.session)
      || !Array.isArray(value.checks) || value.checks.length !== checkIds.length
      || !value.checks.every((row, index) => exactKeys(row, ['id', 'status']) && row.id === checkIds[index] && ['found', 'missing'].includes(row.status))) return;
    const expectedStatus = value.checks.every(row => row.status === 'found') ? 'prerequisites-found' : 'blocked';
    const warnings = [...baseWarnings];
    if (value.platform.os === 'windows') warnings.push('legacy-ipc-needs-port');
    if (value.platform.session === 'wayland') warnings.push('wayland-window-restrictions');
    if (value.status !== expectedStatus || exitCode !== (expectedStatus === 'blocked' ? 2 : 0)
      || JSON.stringify(value.warnings) !== JSON.stringify(warnings)
      || value.checks[4].status !== (['macos', 'linux'].includes(value.platform.os) ? 'found' : 'missing')
      || (value.platform.os === 'linux' ? value.platform.session === 'native'
        : value.platform.session !== (value.platform.os === 'unsupported' ? 'unknown' : 'native'))) return;
    return {
      protocolVersion: 1, kind: 'qt-preflight', status: expectedStatus,
      platform: { os: value.platform.os, session: value.platform.session },
      checks: value.checks.map(row => ({ id: row.id, status: row.status })), warnings,
      nativeModulesImported: false, desktopStarted: false, playerIntegrated: false,
    };
  } catch { return; }
}
