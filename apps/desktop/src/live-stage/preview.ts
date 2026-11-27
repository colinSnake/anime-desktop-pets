import { BrowserWindow, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { WINDOW_SECURITY } from '../security.ts';
import { windowColors } from '../window-colors.ts';
import type { LiveRoleId } from '../../../../packages/contracts/src/live-stage.ts';

/** A fresh, ephemeral permissionless surface. No preload, workbench session, or control bridge. */
export class LiveStagePreview {
  private window?: BrowserWindow;
  private readonly browser = session.fromPartition(`live-stage-${randomBytes(12).toString('hex')}`, {cache:false});
  async open(url: string, role: LiveRoleId = 'longmei') {
    if (this.window && !this.window.isDestroyed()) { this.window.show(); return; }
    const browser = this.browser;
    browser.setPermissionCheckHandler(() => false);
    browser.setPermissionRequestHandler((_c,_p,reply) => reply(false));
    browser.webRequest.onBeforeRequest((details,reply) => reply({cancel:!details.url.startsWith(url)}));
    const win = new BrowserWindow({title:`${role === 'longmei' ? '龙妹' : '鲸鱼妹'}的直播舞台 · 舞台预览`, width:960, height:572, minWidth:480, minHeight:300,
      show:false, autoHideMenuBar:true, backgroundColor:windowColors.liveStage, webPreferences:{...WINDOW_SECURITY,session:browser,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});
    // This local monitor must not double the OBS program audio via desktop capture.
    win.webContents.setAudioMuted(true);
    this.window = win;
    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    const deny = (event: Electron.Event) => event.preventDefault();
    browser.on('will-download', deny);
    win.on('closed', () => {
      browser.removeListener('will-download', deny);
      browser.webRequest.onBeforeRequest(null);
      if (this.window === win) this.window = undefined;
    });
    try { await win.loadURL(url); if (!win.isDestroyed()) win.show(); }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
  }
  close() { this.window?.destroy(); this.window = undefined; }
}
