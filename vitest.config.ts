import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Alias `$lib` → `vendor/hebra/src/lib`, igual que SvelteKit dentro de Hebra. El
 * `?raw` de `schema.sql?raw` (`sqlite-engine.ts:17`) no necesita nada aquí: es una
 * característica nativa de Vite (importar cualquier fichero como texto), y Vitest
 * corre sobre Vite. La build de producción (`scripts/build.mjs`, esbuild) sí necesita
 * un plugin para lo mismo, porque esbuild no lo trae de fábrica.
 */
export default defineConfig({
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./vendor/hebra/src/lib', import.meta.url))
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    // Ningún agente corre suites con varios workers a la vez en esta casa.
    maxWorkers: 1,
    minWorkers: 1
  }
});
