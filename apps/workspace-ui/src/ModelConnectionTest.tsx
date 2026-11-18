import type { ModelProbeError } from '../../../packages/contracts/src/model-probe.ts';
import type { ConnectionTest, ModelWorkspaceController } from './model-state.ts';

const messages: Record<ModelProbeError, string> = {
  invalid_configuration: '测试未发出，请核对默认模型和输出设置。',
  configuration_conflict: '连接版本已变化，请重新读取后再测试。',
  credentials_unavailable: '无法读取此连接的 Key，请核对已保存凭证和系统授权。',
  storage_unavailable: '无法读取隔离配置。', publication_uncertain: '连接发布状态未确认，请重启工作区后再试。',
  busy: '已有模型操作在处理，请稍后再试。', authentication_failed: '服务商拒绝了认证，请检查此连接的 Key 和地址。',
  rate_limited: '服务商限制了请求频率，请稍后再试。', invalid_response: '未收到可用的文字回复。',
  response_too_large: '服务商回复超出测试大小限制。', upstream_unavailable: '生成端点暂不可用或拒绝了测试请求，请核对协议、模型 API ID 和地址。',
  timed_out: '等待回复超时；服务商仍可能处理已收到的请求。',
  cancelled: '已停止等待；已发出的测试仍可能由服务商处理并计费。', unavailable: '本机连接测试暂不可用。',
};
export function ModelConnectionTest({ id, current, savedAddress, confirmingDelete, controller }: { id: string; current?: ConnectionTest; savedAddress?: string; confirmingDelete: boolean; controller: ModelWorkspaceController }) {
  const test = current?.input.connectionID === id ? current : undefined;
  const blocked = confirmingDelete ? '请先结束删除确认。' : controller.connectionTestBlockedReason(id);
  return <>
    {(!test || test.kind === 'result') && <button type="button" className="button secondary" disabled={!!blocked} title={blocked} onClick={() => controller.prepareConnectionTest(id)}>测试连接</button>}
    {test?.kind === 'confirm' && <div className="model-inline" aria-label="确认连接测试">
      <p>向已保存的 <code>{savedAddress}</code> 发出一次简短的文字生成，模型为 <code>{test.input.modelID}</code>。<strong>可能产生费用。</strong>不会发送聊天或角色资料，不会保存草稿。</p>
      <div className="model-actions"><button type="button" className="button secondary" onClick={() => controller.cancelConnectionTest(id)}>取消测试</button>
        <button type="button" className="button" disabled={!!blocked} onClick={() => { void controller.confirmConnectionTest(id); }}>确认发送一次测试</button></div>
    </div>}
    {test?.kind === 'pending' && <div className="model-inline"><p role="status">正在测试 <code>{test.input.modelID}</code>…</p>
      <button type="button" className="button secondary" onClick={() => controller.cancelConnectionTest(id, true)}>停止等待测试</button></div>}
    {test?.kind === 'result' && <p className={`model-test-result ${test.result.ok ? 'model-note' : 'model-alert'}`} role="status">
      <code>{test.input.modelID}</code> · {test.result.ok ? '本次测试收到有效的文字回复。配置未更改。' : messages[test.result.error]}
    </p>}
  </>;
}
