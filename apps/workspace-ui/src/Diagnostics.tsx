import type { Snapshot } from '../../../packages/contracts/src/index.ts';
import { PetNookIcon } from './PetNookIcon.tsx';

export type DiagnosticProps = {
  snapshot?: Snapshot;
  busy: boolean;
  error: string;
  onRefresh(): void;
  onProbe(): void;
};
const platformNames = { macos: 'macOS', windows: 'Windows', linux: 'Linux', unsupported: '非目标系统' };
const runtimeBadges = {
  idle: { label: '尚未探测', tone: '' },
  probing: { label: '探测中', tone: 'warn' },
  ready: { label: '诊断通过', tone: 'good' },
  error: { label: '诊断失败', tone: 'bad' },
  stopped: { label: '已停止', tone: '' },
};
export function diagnosticBadge(snapshot?: Snapshot) {
  return snapshot ? runtimeBadges[snapshot.runtime.status] : { label: '宿主未连接', tone: '' };
}

export function DiagnosticsView({ snapshot, busy, error, onRefresh, onProbe }: DiagnosticProps) {
  return <>
    <div className="advanced-diagnostic-grid">
      <section className="advanced-tile"><h3><PetNookIcon name="models" /> 应用服务</h3>
        <strong>{snapshot ? '本地服务已连接' : '尚未连接'}</strong></section>
      <section className="advanced-tile"><h3><PetNookIcon name="display" /> 当前平台</h3>
        <strong>{snapshot ? platformNames[snapshot.platform.os] : '等待识别'}</strong></section>
      <section className="advanced-tile"><h3><PetNookIcon name="pulse" /> Python 桥接</h3>
        <strong aria-live="polite">{snapshot ? diagnosticBadge(snapshot).label : '不可用'}</strong></section>
    </div>
    <div className="advanced-diagnostic-footer">
      <p className="advanced-diagnostic-notice" aria-live="polite" aria-atomic="true">
        {error || (snapshot?.runtime.status === 'error' ? snapshot.runtime.detail : '')}
      </p>
      <div className="advanced-diagnostic-actions">
        <button className="interaction-button secondary" type="button" disabled={busy} onClick={onRefresh}>
          <PetNookIcon name="refresh" /><span>刷新状态</span>
        </button>
        <button className="interaction-button secondary" type="button" disabled={busy || !snapshot} onClick={onProbe}>
          <PetNookIcon name="pulse" /><span>{snapshot?.runtime.status === 'probing' ? '正在探测…' : '运行 Python 诊断'}</span>
        </button>
      </div>
    </div>
  </>;
}
