#!/usr/bin/env node
/**
 * Empaqueta `src/store/index.ts` con esbuild. Dos cosas que Hebra da por hechas con Vite
 * y esbuild no trae de fábrica (SPEC.md §4.2):
 * - El alias `$lib` (convención de SvelteKit) → `vendor/hebra/src/lib`.
 * - `import x from './fichero.sql?raw'` (el `?raw` de Vite): se resuelve el fichero sin
 *   el sufijo y se carga como texto (`loader: 'text'`, que exporta el contenido como
 *   `export default "…"`, igual que el `?raw` de Vite).
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorLib = join(root, 'vendor', 'hebra', 'src', 'lib');

/** @type {import('esbuild').Plugin} */
const hebraVendorPlugin = {
  name: 'hebra-mcp-vendor',
  setup(api) {
    // `?raw` primero: `$lib/…/schema.sql?raw` (lo importa `src/store/sqlite-conn-node.ts`)
    // también empieza por `$lib/` y el resolvedor de abajo le añadiría `.ts`.
    api.onResolve({ filter: /\.sql\?raw$/ }, (args) => {
      const withoutQuery = args.path.slice(0, -'?raw'.length);
      const resolved = withoutQuery.startsWith('$lib/')
        ? join(vendorLib, withoutQuery.slice('$lib/'.length))
        : isAbsolute(withoutQuery)
          ? withoutQuery
          : join(args.resolveDir, withoutQuery);
      return { path: resolved, namespace: 'hebra-mcp-sql-raw' };
    });
    api.onLoad({ filter: /.*/, namespace: 'hebra-mcp-sql-raw' }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text'
    }));
    api.onResolve({ filter: /^\$lib\// }, (args) => {
      const rest = args.path.slice('$lib/'.length);
      return { path: join(vendorLib, rest.endsWith('.ts') ? rest : `${rest}.ts`) };
    });
  }
};

await build({
  // Un fichero por punto de entrada: `dist/store/index.js`.
  entryPoints: ['store'].map((dir) => join(root, 'src', dir, 'index.ts')),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'external',
  // Sin esto, esbuild sube directorios desde cada fichero buscando un tsconfig.json y
  // se para en el de `vendor/hebra` (que extiende `./.svelte-kit/tsconfig.json`, un
  // fichero que solo genera `svelte-kit sync` y que aquí no existe). El de hebra-mcp
  // no necesita nada de eso: la resolución de `$lib` y del `?raw` la hace el plugin.
  tsconfig: join(root, 'tsconfig.json'),
  outdir: join(root, 'dist'),
  outbase: join(root, 'src'),
  plugins: [hebraVendorPlugin],
  logLevel: 'info'
});
