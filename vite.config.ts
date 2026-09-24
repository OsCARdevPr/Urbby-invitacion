import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// El panel vive en src/web y se compila a dist/web, que sirve el servidor Hono.
// En desarrollo, Vite (5173) reenvía /api y /i al servidor (3000).
export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Con barra final: '/api' a secas también capturaría el módulo /api.ts del panel.
    proxy: {
      '/api/': 'http://localhost:3000',
      '/i/': 'http://localhost:3000',
    },
  },
});
