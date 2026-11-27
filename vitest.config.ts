import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // La biblioteca de prueba se construye una vez (test/fixtures/test-library.ts la copia).
    globalSetup: ['test/fixtures/library-templates-setup.ts'],
    // Ningún agente corre suites con varios workers a la vez en esta casa.
    maxWorkers: 1,
    // Ningún test manda errores a Bugsink: los de `error-reports` pasan su propio entorno y
    // un transporte sin red.
    env: { HEBRA_MCP_ERRORES: '0' }
  }
});
