type QuotaCode = 'busy' | 'timeout' | 'unavailable' | 'authentication' | 'unsupported';
type QuotaWindow = { minutes: number | null; remaining: number | null; resetsAt: number | null };
export type QuotaResult = { kind: 'windows'; rows: QuotaWindow[] } | { kind: 'balance'; amount: number } |
  { kind: 'error'; code: QuotaCode };

const codes: ReadonlySet<unknown> = new Set(['busy', 'timeout', 'unavailable', 'authentication', 'unsupported']);
const unavailable = { kind: 'error', code: 'unavailable' } as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fields = (value: Record<string, unknown>, ...keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const range = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && value >= min && value <= max;

export function parseQuotaResult(input: unknown): QuotaResult | undefined {
  const value = record(input);
  if (!value) return;
  if (value.kind === 'error' && fields(value, 'kind', 'code') && codes.has(value.code)) {
    return { kind: 'error', code: value.code as QuotaCode };
  }
  if (value.kind === 'balance' && fields(value, 'kind', 'amount') && range(value.amount, 0, 1e9)) {
    return { kind: 'balance', amount: value.amount };
  }
  if (value.kind !== 'windows' || !fields(value, 'kind', 'rows') || !Array.isArray(value.rows) ||
      value.rows.length < 1 || value.rows.length > 2) return;
  const rows: QuotaWindow[] = [];
  for (const inputRow of value.rows) {
    const row = record(inputRow);
    if (!row || !fields(row, 'minutes', 'remaining', 'resetsAt')) return;
    const { minutes, remaining, resetsAt } = row;
    if ((minutes !== null && !(range(minutes, 1, 525600) && Number.isInteger(minutes))) ||
        (remaining !== null && !range(remaining, 0, 100)) ||
        (resetsAt !== null && !(range(resetsAt, 1, 4102444800) && Number.isInteger(resetsAt)))) return;
    rows.push({ minutes, remaining, resetsAt });
  }
  return { kind: 'windows', rows };
}

export const invalidQuotaEvent = Symbol('invalid-quota-event');
export function parseQuotaEvent(line: string) {
  let input: unknown;
  try { input = JSON.parse(line); } catch { return; }
  const value = record(input);
  if (!value || (value.event !== 'quota-request' && value.event !== 'quota-cancel')) return;
  const { event, query } = value;
  return typeof query === 'string' && /^[a-f0-9]{32}$/.test(query) &&
    line === JSON.stringify({ version: 3, event, query }) ? { event, query } : invalidQuotaEvent;
}

/** Share one instance across owned players. A timed out source keeps its slot until it settles. */
export class QuotaSlot<Result> {
  private active = false;
  constructor(private readonly read: (signal: AbortSignal) => Promise<unknown>,
    private readonly parse: (value: unknown) => Result | undefined, private readonly timeoutMs = 15_000) {}

  request(deliver: (value: Result | Extract<QuotaResult, { kind: 'error' }>) => void): () => void {
    if (this.active) { deliver({ kind: 'error', code: 'busy' }); return () => {}; }
    this.active = true;
    const controller = new AbortController();
    const abort = () => { clearTimeout(timer); controller.abort(); };
    const timer = setTimeout(() => {
      abort();
      deliver({ kind: 'error', code: 'timeout' });
    }, this.timeoutMs);
    const settle = (result: Result | typeof unavailable) => {
      this.active = false;
      clearTimeout(timer);
      if (!controller.signal.aborted) deliver(result);
    };
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return unavailable;
      try { return this.parse(await this.read(controller.signal)) ?? unavailable; }
      catch { return unavailable; }
    }).then(settle);
    return abort;
  }
}

export class PetQuota extends QuotaSlot<QuotaResult> {
  constructor(read: (signal: AbortSignal) => Promise<unknown>, timeoutMs?: number) {
    super(read, parseQuotaResult, timeoutMs);
  }
}
