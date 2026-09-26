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
    api.onResolve({ filter: /^\$lib\// }, (args) => {
      const rest = args.path.slice('$lib/'.length);
      return { path: join(vendorLib, rest.endsWith('.ts') ? rest : `${rest}.ts`) };
    });
    api.onResolve({ filter: /\.sql\?raw$/ }, (args) => {
      const withoutQuery = args.path.slice(0, -'?raw'.length);
      const resolved = isAbsolute(withoutQuery)
        ? withoutQuery
        : join(args.resolveDir, withoutQuery);
      return { path: resolved, namespace: 'hebra-mcp-sql-raw' };
    });
    api.onLoad({ filter: /.*/, namespace: 'hebra-mcp-sql-raw' }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text'
    }));
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
  // no necesita nada de eso: la resolución de `$lib` y del `?raw` la hace el plugin.
  tsconfig: join(root, 'tsconfig.json'),
  plugins: [hebraVendorPlugin],
  logLevel: 'info'
};

await build({
  ...shared,
  entryPoints: [join(root, 'src', 'store', 'index.ts')],
  outfile: join(root, 'dist', 'store', 'index.js')
});

// Binario `hebra-mcp` (L1, SPEC.md §10): un único fichero ejecutable, con su propio
// shebang (esbuild no lo añade solo: `packages: 'external'` deja el SDK de MCP y zod
// como dependencias normales de `node_modules`, no los empaqueta).
await build({
  ...shared,
  entryPoints: [join(root, 'src', 'server', 'main.ts')],
  outfile: join(root, 'dist', 'cli.mjs'),
  banner: { js: '#!/usr/bin/env node' }
});
