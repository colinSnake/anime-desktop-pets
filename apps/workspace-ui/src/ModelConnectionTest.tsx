import type { ModelProbeError } from '../../../packages/contracts/src/model-probe.ts';
import type { ConnectionTest } from './model-state.ts';

const messages: Record<ModelProbeError, string> = {
  invalid_configuration: '测试未发出，请核对模型和输出设置。',
  configuration_conflict: '连接版本已变化，请重新读取后再测试。',
  credentials_unavailable: '无法读取此连接的 Key，请核对已保存凭证和系统授权。',
  storage_unavailable: '无法读取隔离配置。', publication_uncertain: '连接发布状态未确认，请重启工作区后再试。',
  busy: '已有模型操作在处理，请稍后再试。', authentication_failed: '服务商要求认证或未接受当前 Key，请检查接口地址和 API Key。',
  provider_bad_request: '服务商拒绝了测试参数，请核对协议、模型 API ID 和输出设置。',
  provider_forbidden: '服务商拒绝访问此模型或端点，请检查接口地址和访问权限。',
  provider_not_found: '服务商未找到端点或模型，请核对接口地址和模型 API ID。',
  rate_limited: '服务商限制了请求频率或额度，请检查配额后重试。',
  output_budget_exhausted: '模型耗尽了测试输出预算，连接尚未验证。请检查模型参数和服务商配额。',
  invalid_response: '未收到测试要求的完整文字回复。',
  response_too_large: '服务商回复超出测试大小限制。', upstream_unavailable: '生成端点暂不可用或拒绝了测试请求，请核对协议、模型 API ID 和地址。',
  timed_out: '等待回复超时；服务商仍可能处理已收到的请求。',
  cancelled: '已停止等待；已发出的测试仍可能由服务商处理并计费。', unavailable: '本机连接测试暂不可用。',
};
export function probeResultText(test: Extract<ConnectionTest, { kind: 'result' }>): string {
  return test.result.ok ? '连接通过：本次测试收到有效文字回复。' : messages[test.result.error];
}
