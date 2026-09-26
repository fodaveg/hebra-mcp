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
