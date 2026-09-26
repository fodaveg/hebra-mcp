#!/usr/bin/env node
/**
 * Empaqueta hebra-mcp con esbuild (SPEC.md §4.2).
 *
 * Desde L6b, lo que `vendor/hebra/src/lib/library/node.ts` exporta entra por
 * `src/hebra.ts` con una ruta relativa, y el esquema llega como constante TS
 * (`schema-sql.ts`): el cargador de `?raw` de Vite ya no hace falta y se quitó.
 *
 * El alias `$lib` (convención de SvelteKit) → `vendor/hebra/src/lib` SIGUE haciendo
 * falta para lo que `node.ts` no exporta y hebra-mcp usa: tipos de `types.ts`,
 * `folder-tree`, `canonicalTag` (`notes/tags`), `search-snippet`, `blob-store` y
 * `schema-sql`. Se quitará cuando `node.ts` los exporte (petición a Hebra, informe de
 * L6b).
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorLib = join(root, 'vendor', 'hebra', 'src', 'lib');

/** @type {import('esbuild').Plugin} */
const hebraVendorPlugin = {
  name: 'hebra-mcp-vendor',
  setup(api) {
    api.onResolve({ filter: /^\$lib\// }, (args) => {
      const rest = args.path.slice('$lib/'.length);
      return { path: join(vendorLib, rest.endsWith('.ts') ? rest : `${rest}.ts`) };
    });
  }
};

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  // Sin esto, esbuild sube directorios desde cada fichero buscando un tsconfig.json y
  // se para en el de `vendor/hebra` (que extiende `./.svelte-kit/tsconfig.json`, un
  // fichero que solo genera `svelte-kit sync` y que aquí no existe). El de hebra-mcp
  // no necesita nada de eso: la resolución de `$lib` la hace el plugin.
  tsconfig: join(root, 'tsconfig.json'),
  plugins: [hebraVendorPlugin],
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
