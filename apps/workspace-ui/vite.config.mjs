import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { CONTENT_SECURITY_POLICY } from '../desktop/src/security.ts';

export default defineConfig({
  base: './',
  plugins: [react(), {
    name: 'pet-workspace-production-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', injectTo: 'head-prepend',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY } }],
  }],
  publicDir: false,
  envDir: false,
  envPrefix: [],
  // The pinned Electron renderer supports native modulepreload; keep Vite's async dependency preloading.
  build: { cssCodeSplit: true, sourcemap: false, modulePreload: { polyfill: false } },
});
