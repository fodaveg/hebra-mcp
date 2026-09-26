import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Alias `$lib` → `vendor/hebra/src/lib`, igual que SvelteKit dentro de Hebra, y el mismo
 * que resuelve `scripts/build.mjs`: lo usan lo que `node.ts` de Hebra no exporta y los
 * dobles de test de Hebra (`InMemoryLibraryRelay`, `LocalLibraryPort`, los casos
 * compartidos).
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
