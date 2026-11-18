import {
  isPetInput, isPetResult,
  isPackageImportResult, type PackageImportResult,
  type PetAction, type PetError, type PetInputs, type PetResult, type PetsBridge,
} from '../../../packages/contracts/src/pets.ts';

export const petErrorMessages: Record<PetError, string> = {
  unavailable: '尚未连接桌面宿主或本地服务不可用。请通过 Electron 开发入口打开，或重试读取。',
  invalid: '配置或服务协议不匹配。请检查名称和尺寸；若仍失败，请重新构建工作区。',
  conflict: '配置已被其他操作更新。你的草稿已保留；请先刷新配置，再核对并保存。',
  'not-found': '这个实例已不存在。你的草稿仍保留，请刷新配置后核对。',
  limit: '已达到登记上限（32 个）、开发运行上限（3 个）或素材选择上限（16 项）。请先处理现有项目。',
  active: '实例尚未确认安全停止。请先停止实例；运行失败时也须完成退出确认。',
  busy: '配置正由其他工作区使用。请稍后重试，不要强制结束外部进程。',
  storage: '配置读取或写入失败。你的草稿已保留，请检查本地存储后重试。',
  'package-unavailable': '该角色不在服务认可的目录中。请刷新目录后重新选择。',
  'apply-failed': '播放器未确认应用偏好或显隐状态；已保存配置和未保存草稿均保留。请重试或检查播放器状态。',
};

export async function importPetPackages(bridge: PetsBridge | undefined): Promise<PackageImportResult> {
  if (!bridge) return { ok: false, error: 'unavailable' };
  try {
    const result: unknown = await bridge.importPackages();
    return isPackageImportResult(result) ? result : { ok: false, error: 'unavailable' };
  } catch { return { ok: false, error: 'unavailable' }; }
}

/** Only fixed, typed pet methods cross the bridge; no HTTP, paths, or generic IPC. */
export async function requestPets(bridge: PetsBridge | undefined, action: 'list'): Promise<PetResult>;
export async function requestPets<A extends PetAction>(bridge: PetsBridge | undefined, action: A, input: PetInputs[A]): Promise<PetResult>;
export async function requestPets(bridge: PetsBridge | undefined, action: PetAction | 'list', input?: unknown): Promise<PetResult> {
  if (!bridge) return { ok: false, error: 'unavailable' };
  try {
    let result: unknown;
    if (action === 'list') result = await bridge.list();
    else {
      // Narrow each input independently. This also protects the renderer boundary
      // if a stale host or untyped caller supplies unexpected fields.
      switch (action) {
        case 'add': if (!isPetInput('add', input)) return { ok: false, error: 'invalid' }; result = await bridge.add(input); break;
        case 'start': if (!isPetInput('start', input)) return { ok: false, error: 'invalid' }; result = await bridge.start(input); break;
        case 'stop': if (!isPetInput('stop', input)) return { ok: false, error: 'invalid' }; result = await bridge.stop(input); break;
        case 'applyDisplay': if (!isPetInput('applyDisplay', input)) return { ok: false, error: 'invalid' }; result = await bridge.applyDisplayPreferences(input); break;
        case 'applyBehavior': if (!isPetInput('applyBehavior', input)) return { ok: false, error: 'invalid' }; result = await bridge.applyBehaviorPreferences(input); break;
        case 'visibility': if (!isPetInput('visibility', input)) return { ok: false, error: 'invalid' }; result = await bridge.setVisible(input); break;
        case 'clone': if (!isPetInput('clone', input)) return { ok: false, error: 'invalid' }; result = await bridge.clone(input); break;
        case 'delete': if (!isPetInput('delete', input)) return { ok: false, error: 'invalid' }; result = await bridge.delete(input); break;
        case 'save': if (!isPetInput('save', input)) return { ok: false, error: 'invalid' }; result = await bridge.save(input); break;
        case 'theme': if (!isPetInput('theme', input)) return { ok: false, error: 'invalid' }; result = await bridge.setTheme(input); break;
        case 'pause': if (!isPetInput('pause', input)) return { ok: false, error: 'invalid' }; result = await bridge.pause(input); break;
        case 'resume': if (!isPetInput('resume', input)) return { ok: false, error: 'invalid' }; result = await bridge.resume(input); break;
        default: return { ok: false, error: 'invalid' };
      }
    }
    return isPetResult(result) ? result : { ok: false, error: 'invalid' };
  } catch {
    return { ok: false, error: 'unavailable' };
  }
}
