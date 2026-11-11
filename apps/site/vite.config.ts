import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The marketing site lives at `/`; the editor is a separate app served at `/app/`.
// In dev we proxy `/app` to the editor's dev server so the primary CTA works from either port.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/app': { target: 'http://localhost:5173', changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2022',
    cssMinify: true,
  },
});
