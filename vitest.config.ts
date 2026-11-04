import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // La biblioteca de prueba se construye una vez (test/fixtures/test-library.ts la copia).
    globalSetup: ['test/fixtures/library-templates-setup.ts'],
    // Ningún agente corre suites con varios workers a la vez en esta casa.
    maxWorkers: 1
  }
});
