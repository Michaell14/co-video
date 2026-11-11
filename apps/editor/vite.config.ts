import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env.TANDEM_SERVER ?? 'http://localhost:8787';

export default defineConfig(({ command }) => ({
  // In production the collaboration server hosts the editor under /app/.
  base: command === 'build' ? (process.env.TANDEM_BASE ?? '/app/') : '/',
  plugins: [react()],
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
