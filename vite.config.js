import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative URLs so the build runs from any folder (website /app/, offline package)
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['replicad-opencascadejs'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5173 },
});
