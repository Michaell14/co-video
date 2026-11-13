import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The marketing site lives at `/`; the editor is a separate app that the server hosts at `/app/`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
  build: {
    target: 'es2022',
    cssMinify: true,
  },
});
