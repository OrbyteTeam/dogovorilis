import { defineConfig } from 'vitest/config';

// Unit-тесты чистой логики мини-приложения (навигация, расчёты для экранов) — без DOM и без сети.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
