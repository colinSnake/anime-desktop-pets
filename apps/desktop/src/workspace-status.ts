import type { LinkageState, PetResult, WorkspaceData } from '../../../packages/contracts/src/pets.ts';

export type LinkageAction = 'pause' | 'resume';
export type WorkspaceStatusMenu = { label: string; canOpen: boolean; canRefresh: boolean; linkageAction?: LinkageAction };
type Ports = {
  list(): Promise<PetResult>;
  linkage?(action: LinkageAction, expectedRevision: number): Promise<PetResult>;
  render(menu: WorkspaceStatusMenu): void;
  open(): void;
  hide(): void;
  destroy(): void | Promise<void>;
};
const linkageLabels: Record<LinkageState, string> = {
  active: '联动可用', pausing: '正在暂停', paused: '已暂停', 'stop-unconfirmed': '停止未确认',
};

/** Native menu state for this application only. No external process observation. */
export class WorkspaceStatus {
  private stage: 'starting' | 'loading' | 'ready' | 'unavailable' | 'closed' = 'starting';
  private reading = false;
  private disposed?: Promise<void>;
  private summary = '本机状态未确认';
  private confirmed?: Pick<WorkspaceData, 'linkage' | 'revision'>;
  private changing?: LinkageAction;

  private get linkageAction(): LinkageAction | undefined {
    if (this.stage !== 'ready' || this.reading || this.changing || !this.ports.linkage) return;
    switch (this.confirmed?.linkage) {
      case 'active': case 'stop-unconfirmed': return 'pause';
      case 'paused': return 'resume';
    }
  }
  constructor(private readonly ports: Ports) {}

  render(): void {
    if (this.stage === 'closed') return;
    const ready = this.stage === 'ready';
    const label = this.stage === 'starting' ? '正在启动本地服务…'
      : this.stage === 'loading' ? '正在加载管理工作区…'
        : this.stage === 'unavailable' ? '管理工作区不可用'
          : this.changing ? this.changing === 'pause' ? '正在暂停桌宠联动…' : '正在解除暂停…'
            : this.reading ? '正在读取本机状态…' : this.summary;
    const linkageAction = this.linkageAction;
    this.ports.render({ label, canOpen: ready, canRefresh: ready && !this.reading && !this.changing,
      ...(linkageAction ? { linkageAction } : {}) });
  }
  serviceReady(): void {
    if (this.stage !== 'starting') return;
    this.stage = 'loading';
    this.render();
  }
  async windowReady(): Promise<void> {
    if (this.stage !== 'loading') return;
    this.stage = 'ready';
    await this.refresh();
  }
  windowUnavailable(): void {
    if (this.stage === 'closed') return;
    this.stage = 'unavailable';
    this.render();
  }
  private accept(result?: PetResult): void {
    this.confirmed = undefined;
    this.summary = '本机状态未确认';
    if (!result?.ok) return;
    const { instances, linkage, maximumRunning, revision } = result.workspace;
    const running = instances.filter(row => row.phase === 'running').length;
    const occupied = instances.filter(row => ['starting', 'running', 'stopping', 'failed'].includes(row.phase)).length;
    this.confirmed = { linkage, revision };
    this.summary = `上次确认：${linkageLabels[linkage]} · 运行 ${running} · 占用 ${occupied}/${maximumRunning} 槽`;
  }
  async refresh(): Promise<void> {
    if (this.stage !== 'ready' || this.reading || this.changing) return;
    this.reading = true;
    this.render();
    if (this.stage !== 'ready') return;
    let result: PetResult | undefined;
    try { result = await this.ports.list(); } catch { /* Do not expose service errors in the menu. */ }
    if (this.stage !== 'ready') return;
    this.reading = false;
    this.accept(result);
    this.render();
  }
  async changeLinkage(action: LinkageAction): Promise<void> {
    if (action !== this.linkageAction || !this.confirmed) return;
    const { revision } = this.confirmed;
    this.changing = action;
    this.render();
    if (this.stage !== 'ready') return;
    let result: PetResult | undefined;
    try { result = await this.ports.linkage?.(action, revision); } catch { /* Require a fresh read after an uncertain result. */ }
    if (this.stage !== 'ready') return;
    this.changing = undefined;
    this.accept(result);
    this.render();
  }
  open(): void {
    if (this.stage === 'ready') this.ports.open();
  }
  closeWindow(preventDefault: () => void): void {
    if (this.stage !== 'ready') return;
    preventDefault();
    this.ports.hide();
  }
  dispose(): Promise<void> {
    if (this.stage !== 'closed') {
      this.stage = 'closed';
      this.disposed = Promise.resolve(this.ports.destroy());
    }
    return this.disposed ?? Promise.resolve();
  }
}
