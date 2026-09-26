#!/usr/bin/env node
/**
 * Empaqueta hebra-mcp con esbuild (SPEC.md §4.2).
 *
 * Desde L6b, lo que `vendor/hebra/src/lib/library/node.ts` exporta entra por
 * `src/hebra.ts` con una ruta relativa, y el esquema llega como constante TS
 * (`schema-sql.ts`): el cargador de `?raw` de Vite ya no hace falta y se quitó.
 *
 * El alias `$lib` (convención de SvelteKit) → `vendor/hebra/src/lib` ya no hace falta
 * (D5, `199c3d1d`): lo último que lo usaba fuera de producción era el dispatcher propio
 * de los casos compartidos, y `node-testing.ts` ya exporta el arnés corrido
 * (`ALL_LIBRARY_CASES`/`runLibraryCase`, `test/library-cases.node.test.ts`). El plugin
 * de resolución se quitó con él.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  // Sin esto, esbuild sube directorios desde cada fichero buscando un tsconfig.json y
  // se para en el de `vendor/hebra` (que extiende `./.svelte-kit/tsconfig.json`, un
  // fichero que solo genera `svelte-kit sync` y que aquí no existe).
  tsconfig: join(root, 'tsconfig.json'),
  logLevel: 'info'
};

await build({
  ...shared,
  // Un fichero por punto de entrada: `dist/store/index.js`, `dist/sync/index.js` (motor
  // de sync e instancia, L3) y `dist/lock/index.js` (escritor único, L3). Sin
  // `splitting`: cada uno es autónomo (el servidor de L1 importa de las FUENTES,
  // `src/store`/`src/sync`, no de estos `dist/*`).
  entryPoints: ['store', 'sync', 'lock'].map((dir) => join(root, 'src', dir, 'index.ts')),
  outdir: join(root, 'dist'),
  outbase: join(root, 'src')
});

// Binario `hebra-mcp` (L1, SPEC.md §10): un único fichero ejecutable, con su propio
// shebang (esbuild no lo añade solo: `packages: 'external'` deja el SDK de MCP y zod
// como dependencias normales de `node_modules`, no los empaqueta). Aparte del `build()`
// de arriba porque su nombre (`cli.mjs`, el que fija `bin` en `package.json`) no sale
// de `outdir`/`outbase` (que daría `dist/server/main.js`); autónomo igual que los otros:
// importa de `src/store` y `src/privacy`, no de `dist/store/index.js`.
await build({
  ...shared,
  entryPoints: [join(root, 'src', 'server', 'main.ts')],
  outfile: join(root, 'dist', 'cli.mjs'),
  banner: { js: '#!/usr/bin/env node' }
});
