import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const harnessPort = process.env.HB_PORT || process.env.OGB_PORT || '8799';

export default defineConfig({
  // Where the UI will be served from. '/' standalone; the mount prefix when the
  // Hermes dashboard plugin serves it (HB_BASE=api/plugins/harnessbot/ui).
  //
  // Written without leading or trailing slashes and normalised here on purpose:
  // MSYS shells rewrite any value that starts with '/' into a Windows path, so
  // both `--base=/x/` and `HB_BASE=/x/` silently produce a build whose asset URLs
  // point at the shell's install root. A slash-free value survives every shell.
  base: process.env.HB_BASE ? `/${process.env.HB_BASE.replace(/^\/+|\/+$/g, '')}/` : '/',
  // Static files and the API split apart when Hermes serves this UI: assets come
  // from its unauthenticated plugin-asset route, the API from an authenticated
  // one. Defined explicitly rather than relying on VITE_-prefix forwarding, so a
  // shell that does not export it cannot silently produce a same-origin build.
  define: {
    'import.meta.env.VITE_HB_API_BASE': JSON.stringify(process.env.HB_API_BASE || ''),
  },
  plugins: [react(), tailwind()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.HB_UI_PORT || 5199),
    strictPort: false,
    proxy: { '/api': { target: `http://127.0.0.1:${harnessPort}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: true },
});
