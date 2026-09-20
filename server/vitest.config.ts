import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Тесты с БД работают против одной базы и очищают её между кейсами:
    // параллельный запуск файлов затирал бы данные соседнего файла.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
