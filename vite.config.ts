import { defineConfig } from 'vite';

// İstemci Vite ile derlenir; geliştirme sırasında API ve SSE ofis sunucusuna yönlendirilir.
export default defineConfig({
  root: 'src/client',
  // three.js is its own lazy chunk of about 640 kB, loaded after the UI
  build: { outDir: '../../dist/client', emptyOutDir: true, chunkSizeWarningLimit: 700 },
  server: { proxy: { '/api': 'http://127.0.0.1:4317' } },
});
