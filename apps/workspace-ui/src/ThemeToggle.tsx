import type { Theme } from '../../../packages/contracts/src/pets.ts';

const titles: Record<Theme, string> = { system: '跟随系统', dark: '深色主题', light: '浅色主题' };
/** Keep the existing macOS toolbar's system → dark → light cycle. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';
}

export function ThemeToggle({ theme, disabled, onChange, showLabel }: {
  theme: Theme; showLabel?: boolean; disabled: boolean; onChange(theme: Theme): void;
}) {
  const label = `外观：${titles[theme]}`;
  return <button type="button" className="theme-toggle" aria-label={label} title={`${label}（点击切换）`} disabled={disabled} onClick={() => onChange(nextTheme(theme))}>
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {theme === 'system' ? <><rect x="2.5" y="3.5" width="15" height="10.5" rx="2" /><path d="M10 14v3m-3 0h6" /></>
        : theme === 'dark' ? <path d="M16.4 11.5A6.6 6.6 0 0 1 8.5 3.6a6.6 6.6 0 1 0 7.9 7.9Z" fill="currentColor" stroke="none" />
        : <><circle cx="10" cy="10" r="3.2" fill="currentColor" stroke="none" /><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M4.2 15.8l1.4-1.4M14.4 5.6l1.4-1.4" /></>}
    </svg>{showLabel && <span aria-hidden="true">{theme === 'system' ? '系统' : theme === 'dark' ? '深色' : '浅色'}</span>}
  </button>;
}
