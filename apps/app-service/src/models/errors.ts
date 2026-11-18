export type ModelErrorCode = 'invalid_configuration' | 'not_configured' | 'route_changed' | 'invalid_request' | 'tools_unavailable' | 'credentials_unavailable' | 'invalid_response' | 'response_too_large' | 'authentication_failed' | 'rate_limited' | 'upstream_unavailable' | 'cancelled' | 'timed_out' | 'busy' | 'closed';
/** 固定错误枚举；不附带 URL、Header、原始响应、凭证或异常 cause。 */
export class ModelError extends Error {
  constructor(readonly code: ModelErrorCode) { super(code); this.name = 'ModelError'; }
}
