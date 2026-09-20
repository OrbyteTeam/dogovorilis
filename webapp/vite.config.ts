import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Мини-приложение раздаётся сервером по пути /app/ (см. docs/SPEC.md §4.2).
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: { '/api': 'http://localhost:8080' },
  },
});
