import { DiagnosticsView, type DiagnosticProps } from '../Diagnostics.tsx';
import { DisabledAction, ModulePage, OptionRow, Panel, Split } from './WorkspacePanels.tsx';

export function AdvancedPage({ diagnostics }: { diagnostics: DiagnosticProps }) {
  return <ModulePage title="高级" description="了解本机数据与系统权限，并检查新工作区的运行状态。" preview={false}>
    <Split main={<Panel title="本机数据">
      <OptionRow title="工作区数据" detail="此入口用于查看新工作区的隔离目录，尚未接入。"><DisabledAction>打开数据文件夹</DisabledAction></OptionRow>
      <OptionRow title="旧资料迁移" detail="尚未迁移旧资料；不会自动扫描、导入或覆盖。"><DisabledAction>选择迁移快照</DisabledAction></OptionRow>
    </Panel>} aside={<Panel title="系统权限">
      <OptionRow title="窗口尺寸辅助功能" detail="权限状态尚未读取；页面不会发起系统权限请求。"><DisabledAction>查看辅助功能设置</DisabledAction></OptionRow>
    </Panel>} />
    <DiagnosticsView {...diagnostics} />
  </ModulePage>;
}
