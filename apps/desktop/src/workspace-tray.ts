import { dialog, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';
import { CodexObservation, type CodexObservationState } from './codex-observation.ts';
import type { CodexPresence } from './codex-presence.ts';
import { WorkspaceStatus } from './workspace-status.ts';
import type { PetResult } from '../../../packages/contracts/src/pets.ts';

import type { TaskFollowingState } from '../../app-service/src/codex-task-following.ts';

type Actions = { list(): Promise<PetResult>; readCodex(): Promise<CodexPresence>; launchCodex(): void; open(): void; hide(): void; quit(): void;
  taskFollowing?: { state(): TaskFollowingState; setEnabled(enabled: boolean): boolean };
};
const taskLabels: Record<TaskFollowingState, string> = {
  off: 'Codex 本机任务：未开启读取', checking: 'Codex 本机任务：正在确认…', waiting: 'Codex 本机任务：等待客户端运行',
  working: 'Codex 本机任务：上次检测到活动任务', idle: 'Codex 本机任务：上次未检测到活动任务', unknown: 'Codex 本机任务：状态未确认',
};
const codexLabels: Record<CodexObservationState, string> = {
  off: 'Codex：未开启观察',
  checking: 'Codex：正在读取…',
  running: 'Codex：上次检测到运行',
  'not-detected': 'Codex：上次未检测到运行',
  unknown: 'Codex：状态未确认',
};

export function installWorkspaceTray(iconPath: string, actions: Actions): WorkspaceStatus | undefined {
  if (process.platform !== 'darwin') return;
  let tray: Tray | undefined;
  let destroyed = false;
  let confirming = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    actions.taskFollowing?.setEnabled(false);
    try { tray?.destroy(); } catch { /* Continue application-owned cleanup. */ }
  };
  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) return;
    icon.setTemplateImage(true);
    const item = tray = new Tray(icon);
    item.setToolTip('桌边小崽');
    const observation = new CodexObservation({ read: actions.readCodex, changed: () => status.render() });
    const toggleTaskFollowing = async () => {
      const task = actions.taskFollowing;
      if (destroyed || confirming || !task) return;
      if (task.state() !== 'off') { task.setEnabled(false); return; }
      confirming = true;
      status.render();
      try {
        const answer = await dialog.showMessageBox({ type: 'question', title: 'Codex 本机任务读取',
          message: '允许本次会话读取 Codex 本机任务状态？',
          detail: '只在检测到 Codex 运行时读取 ~/.codex/sessions 的本机生命周期事件。菜单只显示聚合状态，不展示或保存会话正文，不发起任务或查询额度。暂停联动、停止读取或退出时撤销。运行中的自有桌宠会随任务切换工作动画。',
          buttons: ['取消', '允许本次会话'], defaultId: 0, cancelId: 0, noLink: true });
        if (!destroyed && answer.response === 1) task.setEnabled(true);
      } catch { /* Without explicit confirmation, keep reading disabled. */ }
      finally { confirming = false; status.render(); }
    };
    const status = new WorkspaceStatus({ ...actions, destroy: () => {
      const closing = observation.dispose();
      destroy();
      return closing;
    }, render: menu => {
      try {
        const task = actions.taskFollowing?.state();
        const taskItems: MenuItemConstructorOptions[] = task === undefined ? [] : [
          { type: 'separator' }, { label: taskLabels[task], enabled: false },
          { label: task === 'off' ? '开始读取 Codex 本机任务…' : '停止读取 Codex 本机任务',
            enabled: !confirming && (menu.canOpen || task !== 'off'), click: () => { void toggleTaskFollowing(); } },
        ];
        const observing = observation.state !== 'off';
        item.setContextMenu(Menu.buildFromTemplate([
          { label: menu.label, enabled: false },
          { type: 'separator' },
          { label: '打开管理工作区', enabled: menu.canOpen, click: () => status.open() },
          { label: '刷新本机状态', enabled: menu.canRefresh, click: () => { void status.refresh(); } },
          { type: 'separator' },
          { label: '打开 Codex', enabled: menu.canOpen, click: () => actions.launchCodex() },
          { label: codexLabels[observation.state], enabled: false },
          { label: observing ? '停止观察 Codex' : '开始观察 Codex', click: () => observation.setEnabled(!observing) },
          ...taskItems,
          { type: 'separator' },
          { label: '退出桌边小崽', click: () => actions.quit() },
        ]));
      } catch { void status.dispose(); }
    } });
    status.render();
    return status;
  } catch { destroy(); return undefined; }
}
