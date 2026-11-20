import { app, Menu, protocol, session } from 'electron';
import { join } from 'node:path';
import { previewResponse, previewScheme, readCaptionFont } from './media';
import { createVideoWindow } from './video-window';
import { isClip, mediaFiles } from './playback';

const folder = __dirname;
app.setName('桌边小崽 · 视频预览');
app.setPath('userData', join(folder, 'profile'));
app.setPath('sessionData', join(folder, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: previewScheme, privileges: { standard: true, secure: true, stream: true } }]);
app.on('window-all-closed', () => app.quit());

async function openPreview() {
  const localSession = session.fromPartition('pet-video-preview', { cache: false });
  localSession.setPermissionCheckHandler(() => false);
  localSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const font = await readCaptionFont(folder);
  localSession.protocol.handle(previewScheme, request => previewResponse(folder, request, folder, font));
  const window = createVideoWindow({ folder, localSession });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '视频预览', submenu: [
    { label: '播放工作动作', accelerator: 'CmdOrCtrl+Shift+W', click: window.work },
    { label: '回到待机', accelerator: 'Escape', click: window.idle },
    { label: '试播原始动作（不移动窗口）', submenu: mediaFiles.map(file => ({
      label: file === 'release' ? 'landing' : file === 'work' ? 'work01' : file,
      click: () => {
        const next = file.startsWith('move') ? `full-${file}` : file;
        if (isClip(next)) window.previewClip(next);
      },
    })) },
    { type: 'separator' }, { label: '退出视频预览', role: 'quit' },
  ] }]));
  if (!await window.ready) throw new Error('video_preview_unavailable');
}

void app.whenReady().then(openPreview).catch(() => {
  console.error('透明视频预览启动失败；现有桌宠未受控制。');
  app.exit(1);
});
