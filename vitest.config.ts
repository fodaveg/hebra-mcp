import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Ningún agente corre suites con varios workers a la vez en esta casa.
    maxWorkers: 1,
    minWorkers: 1
  }
});
