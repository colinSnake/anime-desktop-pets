import type { LinkageState, PetResult } from '../../../packages/contracts/src/pets.ts';

export type WorkspaceStatusMenu = { label: string; canOpen: boolean; canRefresh: boolean };
type Ports = {
  list(): Promise<PetResult>;
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
  constructor(private readonly ports: Ports) {}

  render(): void {
    if (this.stage === 'closed') return;
    const ready = this.stage === 'ready';
    const label = this.stage === 'starting' ? '正在启动本地服务…'
      : this.stage === 'loading' ? '正在加载管理工作区…'
        : this.stage === 'unavailable' ? '管理工作区不可用'
          : this.reading ? '正在读取本机状态…' : this.summary;
    this.ports.render({ label, canOpen: ready, canRefresh: ready && !this.reading });
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
  async refresh(): Promise<void> {
    if (this.stage !== 'ready' || this.reading) return;
    this.reading = true;
    this.render();
    if (this.stage !== 'ready') return;
    let summary = '本机状态未确认';
    try {
      const result = await this.ports.list();
      if (result.ok) {
        const { instances, linkage, maximumRunning } = result.workspace;
        const running = instances.filter(row => row.phase === 'running').length;
        const occupied = instances.filter(row => ['starting', 'running', 'stopping', 'failed'].includes(row.phase)).length;
        summary = `上次确认：${linkageLabels[linkage]} · 运行 ${running} · 占用 ${occupied}/${maximumRunning} 槽`;
      }
    } catch { /* Fixed state only; never expose diagnostics in the menu. */ }
    if (this.stage !== 'ready') return;
    this.reading = false;
    this.summary = summary;
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
