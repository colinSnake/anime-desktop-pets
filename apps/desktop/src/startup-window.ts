import { BrowserWindow, screen, session } from 'electron';
import { centeredStartupBounds, startStartupAlignment, type StartupBounds } from './startup-alignment.ts';
import { startupResponse } from './startup-assets.ts';
import { STARTUP_SCHEME, STARTUP_URL, manageStartupPlayback, startupSignal } from './startup-playback.ts';
import { WINDOW_SECURITY } from './security.ts';
import { windowColors } from './window-colors.ts';

export function installStartupPlayer(directory: string, readBounds: (signal: AbortSignal) => Promise<StartupBounds | undefined>) {
  const isolated = session.fromPartition('codex-startup-video');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', event => event.preventDefault());
  isolated.protocol.handle(STARTUP_SCHEME, request => startupResponse(directory, request));
  return () => {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const win = new BrowserWindow({
      ...centeredStartupBounds(area, 0.9), title: '桌边小崽 · 启动动画', show: false, frame: false, backgroundColor: windowColors.startup,
      alwaysOnTop: true, resizable: false, fullscreenable: false, skipTaskbar: true, acceptFirstMouse: true,
      webPreferences: { ...WINDOW_SECURITY, session: isolated, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    const playback = manageStartupPlayback({
      show: () => win.showInactive(), close: () => { if (!win.isDestroyed()) win.destroy(); },
      startAlignment: () => startStartupAlignment({
        read: readBounds, displays: () => screen.getAllDisplays(),
        apply: bounds => { if (!win.isDestroyed() && win.isVisible()) win.setBounds(bounds, false); },
      }),
    });
    win.on('closed', playback.close);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-redirect', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('render-process-gone', playback.close);
    win.webContents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      const signal = startupSignal(url, mainFrame);
      if (signal) playback.signal(signal);
    });
    void win.loadURL(STARTUP_URL).catch(playback.close);
    return playback;
  };
}
