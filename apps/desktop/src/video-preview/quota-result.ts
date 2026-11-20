import { parseQuotaResult, type QuotaResult } from '../../../app-service/src/pet-quota';

const currencies = new Set<unknown>(['USD', 'CNY', 'EUR', 'JPY', 'GBP', 'CAD', 'AUD']);
export const previewErrors = ['cli', 'configuration', 'endpoint', 'network', 'response'] as const;
type PreviewError = { kind: 'error'; code: typeof previewErrors[number] };
type Balance = { kind: 'balance'; amount: number; currency: string };
export type PreviewQuotaResult = Exclude<QuotaResult, { kind: 'balance' }> | Balance | PreviewError;

export function parsePreviewQuotaResult(input: unknown): PreviewQuotaResult | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return;
  const value = input as Record<string, unknown>;
  if (value.kind === 'error' && Object.keys(value).length === 2) {
    const code = previewErrors.find(item => item === value.code);
    if (code) return { kind: 'error', code };
  }
  if (value.kind !== 'balance') {
    const parsed = parseQuotaResult(value);
    if (parsed?.kind !== 'balance') return parsed;
    return;
  }
  const { currency, ...amount } = value;
  const parsed = parseQuotaResult(amount);
  if (parsed?.kind === 'balance' && typeof currency === 'string' && currencies.has(currency)) return { ...parsed, currency };
}
