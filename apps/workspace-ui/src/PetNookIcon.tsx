const paths = {
  pets: 'M6 12a4 4 0 0 1-2-7l.8 3 2.4.7A9 9 0 0 1 12 7a9 9 0 0 1 4.8 1.7l2.4-.7.8-3a4 4 0 0 1-2 7c1.2 1.2 2 2.7 2 4.2 0 3-3.6 4.3-8 4.3s-8-1.3-8-4.3c0-1.5.8-3 2-4.2ZM9 15h.01M15 15h.01M11 17.5q1 1 2 0',
  chat: 'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.5-3.4A8.5 8.5 0 1 1 21 11.5ZM8.5 11.5h.01m3.5 0h.01m3.5 0h.01',
  identity: 'M14 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5ZM6 15c1.6-3 5.4-3 7 0m2-5h3m-3 4h3M11.5 9.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
  memory: 'M6 3h13v17H6a2 2 0 0 1 0-4h13M4 18V5a2 2 0 0 1 2-2m2 5h7m-7 4h5',
  goals: 'M21 12a9 9 0 0 1-18 0 9 9 0 0 1 18 0Zm-4 0a5 5 0 0 1-10 0 5 5 0 0 1 10 0Zm-5 0h.01',
  models: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  audio: 'M3 10v4m4-7v10m5-14v18m5-14v10m4-7v4',
  speech: 'M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6Zm-3 5v1a6 6 0 0 0 12 0v-1m-6 7v3m-3 0h6',
  live: 'M4 5h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm6 4 5 2.5-5 2.5V9ZM9 21h6',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 3h18',
  pulse: 'M3 12h4l3-6 4 12 3-6h4',
  display: 'M3 4h18v13H3zM12 17v4m-4 0h8',
  refresh: 'M20 10a8 8 0 1 0-1 6m1-11v5h-5',
  spark: 'M12 2c.8 6.5 3.5 9.2 10 10-6.5.8-9.2 3.5-10 10-.8-6.5-3.5-9.2-10-10 6.5-.8 9.2-3.5 10-10Z',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm9 6 6 6-6 6',
  close: 'm6 6 12 12M18 6 6 18',
  down: 'm7 10 5 5 5-5',
  more: 'M5 12h.01m7 0h.01m7 0h.01',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18m-9-9c4 4 4 14 0 18-4-4-4-14 0-18Z',
  lock: 'M6 10h12v10H6zM9 10V7a3 3 0 1 1 6 0v3m-3 4v2',
  search: 'M16 16l4 4M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  fileUpload: 'M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10Zm0 0v7h7m-8 8v-6m-3 3 3-3 3 3',
  send: 'M12 19V5m-6 6 6-6 6 6',
  stop: 'M7 7h10v10H7z',
  alert: 'M12 7v6m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
} as const;

export function PetNookIcon({ name, className = 'pet-nook-icon' }: { name: keyof typeof paths | 'advanced'; className?: string }) {
  // Lucide Settings2, exact geometry; ISC notice in licenses/lucide.txt.
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'advanced' ? 2 : 1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'advanced' ? <><path d="M14 17H5" /><path d="M19 7h-9" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></> : <path d={paths[name]} />}
  </svg>;
}
