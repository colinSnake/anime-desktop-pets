import assert from 'node:assert/strict';
import test from 'node:test';
import { safeQtReport } from './qt-preflight-report.mjs';
const report = () => ({
  protocolVersion: 1, kind: 'qt-preflight', status: 'prerequisites-found',
  platform: { os: 'macos', session: 'native' },
  checks: ['python-3.10', 'pyside6', 'pillow', 'adapter-sources', 'legacy-ipc-platform'].map(id => ({ id, status: 'found' })),
  warnings: ['player-not-integrated', 'desktop-matrix-unverified', 'native-libraries-and-assets-unverified'],
  nativeModulesImported: false, desktopStarted: false, playerIntegrated: false,
});
test('Qt report accepts only a bounded fixed-schema report consistent with the exit code', () => {
  assert.deepEqual(safeQtReport(JSON.stringify(report()), 0), report());
  assert.equal(safeQtReport(JSON.stringify(report()), 2), undefined);
  const blocked = report(); blocked.status = 'blocked'; blocked.checks[1].status = 'missing';
  assert.deepEqual(safeQtReport(JSON.stringify(blocked), 2), blocked);
});
test('Qt report rejects startup output, paths, extra keys, unknown values and false success', () => {
  for (const value of [
    'secret/path\n' + JSON.stringify(report()), 'x'.repeat(4097),
    JSON.stringify({ ...report(), secret: '/private/key' }),
    JSON.stringify({ ...report(), warnings: ['secret/path'] }),
    JSON.stringify({ ...report(), platform: { os: 'macos', session: '/private/path' } }),
    JSON.stringify({ ...report(), playerIntegrated: true }),
    JSON.stringify({ ...report(), checks: [] }),
  ]) assert.equal(safeQtReport(value, 0), undefined);
});
