import { defineConfig } from 'vitest/config';

/** Medidas que tardan (`test/perf/*.perf.ts`), fuera de `npm test`: `npm run perf:grep`. */
export default defineConfig({
  test: {
    include: ['test/perf/**/*.perf.ts'],
    maxWorkers: 1,
    minWorkers: 1
  }
});
