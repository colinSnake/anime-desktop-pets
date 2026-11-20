import { useState, type ReactNode } from 'react';
import type { DesktopBridge } from '../../../../packages/contracts/src/index.ts';
import { diagnosticBadge, DiagnosticsView, type DiagnosticProps } from '../Diagnostics.tsx';
import { PetNookIcon } from '../PetNookIcon.tsx';
import { InteractionLayout } from './InteractionLayout.tsx';

export function AdvancedPage({ diagnostics, openWorkspaceData, appearance }: {
  diagnostics: DiagnosticProps; openWorkspaceData?: DesktopBridge['openWorkspaceData']; appearance?: ReactNode;
}) {
  const [opening, setOpening] = useState(false);
  const [notice, setNotice] = useState('');
  const badge = diagnosticBadge(diagnostics.snapshot);
  async function openData() {
    if (opening || !openWorkspaceData) return;
    setOpening(true);
    setNotice('');
    try {
      const result = await openWorkspaceData();
      setNotice(result === 'opened' ? '已交给系统文件管理器。'
        : result === 'not-ready' ? '工作区数据目录尚未初始化。'
        : result === 'busy' ? '正在打开，请稍候。' : '暂时无法打开工作区数据目录。');
    } catch { setNotice('暂时无法打开工作区数据目录。'); }
    finally { setOpening(false); }
  }
  return <InteractionLayout page="advanced" title="高级" description="管理本机工作区，按需查看运行详情。" appearance={appearance}>
    <section className="interaction-hero advanced-hero" aria-labelledby="advanced-local-title">
      <div className="interaction-hero-copy"><span className="interaction-eyebrow"><PetNookIcon name="lock" />本机数据</span>
        <h2 id="advanced-local-title">工作区数据</h2><p>打开桌边小崽专用的数据文件夹。</p>
        <div className="advanced-local-actions">
          <button type="button" className="interaction-button primary" disabled={opening || !openWorkspaceData} onClick={() => { void openData(); }}>
            <PetNookIcon name="folder" /><span>{opening ? '正在打开…' : '打开数据文件夹'}</span>
          </button>
          <span className="advanced-data-status" role="status" hidden={!notice && !!openWorkspaceData}>{openWorkspaceData ? notice : '等待桌面宿主连接'}</span>
        </div>
      </div>
      <div className="interaction-art advanced-art" aria-hidden="true"><span className="interaction-halo"/><span className="interaction-orbit"/><span className="interaction-orbit second"/>
        <span className="interaction-star top"><PetNookIcon name="spark" /></span><span className="interaction-star bottom"><PetNookIcon name="spark" /></span>
        <div className="advanced-case"><span className="advanced-case-tab"/><span className="advanced-case-note"><img src="./assets/app-icon.svg" alt="" draggable={false}/></span><span className="advanced-case-face"><span /></span></div>
        <span className="interaction-sticker"><PetNookIcon name="lock" /></span>
      </div>
    </section>
    <section className="advanced-tools" aria-labelledby="advanced-tools-title">
      <div className="advanced-tools-heading"><h2 id="advanced-tools-title">维护工具</h2></div>
      <details className="advanced-tool">
        <summary>
          <span className="advanced-tool-icon"><PetNookIcon name="pulse" /></span>
          <strong className="advanced-tool-title">运行诊断</strong>
          <span className="interaction-pill muted dot" data-tone={badge.tone}>{badge.label}</span>
          <PetNookIcon name="down" />
        </summary>
        <div className="advanced-tool-body"><DiagnosticsView {...diagnostics} /></div>
      </details>
    </section>
  </InteractionLayout>;
}
