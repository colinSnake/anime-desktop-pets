import type { PreviewBridge, PreviewQuotaState } from './bridge';
import type { Point } from './motion';

const messages = {
  busy: '上一次查询还在收尾，请稍后刷新。',
  timeout: '查询超时，请检查网络后重试。',
  unsupported: '当前 Codex 服务未接入额度查询。',
  authentication: '请检查当前 Codex 登录或 TiMi CC 密钥。',
  unavailable: '当前没有可读取的额度，请稍后重试。',
  cli: '未找到 Codex CLI。请检查本机 Codex 安装。',
  configuration: '请检查 Codex 当前配置和 CC Switch 的 TiMi CC 用量模板。',
  endpoint: 'TiMi CC 的用量地址不可用或返回了重定向。',
  network: '未能连接 TiMi CC 用量服务，请检查网络后重试。',
  response: 'TiMi CC 未返回可显示的余额，请查看中转账户。',
};
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const reset = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const amountFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function text(tag: string, value: string) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

export function createQuotaCard(bridge: PreviewBridge, geometryChanged: () => void) {
  const card = document.querySelector<HTMLElement>('#pet-quota')!;
  const title = document.querySelector<HTMLElement>('#quota-title')!;
  const body = document.querySelector<HTMLElement>('#quota-result')!;
  const footer = document.querySelector<HTMLElement>('#quota-footer')!;
  const source = document.querySelector<HTMLElement>('#quota-source')!;
  const updated = document.querySelector<HTMLElement>('#quota-time')!;
  const refresh = document.querySelector<HTMLButtonElement>('#quota-refresh')!;
  const close = document.querySelector<HTMLButtonElement>('#quota-close')!;
  refresh.addEventListener('click', () => bridge.refreshQuota());
  close.addEventListener('click', () => bridge.closeQuota());

  function show(state: PreviewQuotaState) {
    card.hidden = state.kind === 'closed';
    body.replaceChildren();
    footer.hidden = !('queriedAt' in state);
    source.textContent = state.kind === 'windows' ? 'Codex' : state.kind === 'balance' ? `TiMi CC · ${state.currency}` : '';
    updated.textContent = 'queriedAt' in state ? `查询于 ${time.format(state.queriedAt)}` : '';
    refresh.disabled = state.kind === 'loading';
    title.textContent = state.kind === 'windows' ? '订阅额度' : state.kind === 'balance' ? '中转余额' : '查询额度';
    if (state.kind === 'loading') body.append(text('p', '正在读取当前额度…'));
    else if (state.kind === 'error') body.append(text('p', messages[state.code]));
    else if (state.kind === 'balance') body.append(text('strong', amountFormat.format(state.amount)));
    else if (state.kind === 'windows') for (const row of state.rows) {
      const section = document.createElement('div');
      section.className = 'quota-window';
      const label = row.minutes === 300 ? '5 小时' : row.minutes === 10080 ? '一周' : row.minutes ? `${row.minutes} 分钟` : '额度窗口';
      section.append(text('span', label), text('b', row.remaining === null ? '剩余未知' : `剩余 ${Number(row.remaining.toFixed(1))}%`));
      if (row.remaining !== null) {
        const bar = document.createElement('progress');
        bar.max = 100;
        bar.value = row.remaining;
        bar.title = `${label}剩余额度`;
        bar.setAttribute('aria-label', bar.title);
        bar.dataset.level = row.remaining <= 15 ? 'low' : row.remaining <= 40 ? 'caution' : 'normal';
        section.append(bar);
      }
      if (row.resetsAt !== null) section.append(text('small', `${reset.format(row.resetsAt * 1000)} 重置`));
      body.append(section);
    }
    geometryChanged();
  }
  bridge.onQuota(show);
  return {
    contains(point: Point) {
      if (card.hidden) return false;
      const { left, top, right, bottom } = card.getBoundingClientRect();
      return point.x >= left && point.y >= top && point.x < right && point.y < bottom;
    },
  };
}
