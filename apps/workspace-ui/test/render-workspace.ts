import { registerHooks } from 'node:module';
import type { ReactNode } from 'react';
import { prerender } from 'react-dom/static';

// Only the Node markup tests ignore these styles; the built entry graph is tested separately.
const styles = new Set(['chat.css', 'models.css', 'pages/pages.css', 'pages/interaction-pages.css', 'pages/live-workbench.css', 'pages/advanced.css'].map(path => new URL(`../src/${path}`, import.meta.url).href));
registerHooks({ load(url, context, nextLoad) {
  if (styles.has(url)) return { format: 'module', source: '', shortCircuit: true };
  return nextLoad(url, context);
} });

export async function renderWorkspace(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(node);
  return new Response(prelude).text();
}
