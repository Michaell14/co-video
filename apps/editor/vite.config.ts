import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { serviceWorkerFiles, serviceWorkerSource } from './serviceWorker.ts';

const server = process.env.TANDEM_SERVER ?? 'http://localhost:8787';

/** Emits `sw.js` (see `serviceWorker.ts`) for the files of this build. */
function serviceWorker(): Plugin {
  return {
    name: 'tandem-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = serviceWorkerFiles(Object.keys(bundle));
      const names = [...files.precache, ...files.onUse].join('\n');
      const version = createHash('sha256').update(names).digest('hex').slice(0, 12);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorkerSource({ version, ...files }) });
    },
  };
}

export default defineConfig(({ command }) => ({
  // In production the collaboration server hosts the editor under /app/.
  base: command === 'build' ? (process.env.TANDEM_BASE ?? '/app/') : '/',
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
}));
