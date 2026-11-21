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
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * HS-5 (12 nov 2026): `space-history-client.ts` de Hebra importa `recordDiagnostic` del
 * registro de diagnóstico de la app (`lib/diagnostics/index.ts`), que trae los sumideros de
 * IndexedDB y Tauri y lee `localStorage`. hebra-mcp le pasa su propio `diagnostic` y nunca lo
 * llama: en `dist/` ese import, y SOLO desde ese fichero, va a `src/shims/hebra-diagnostics.ts`.
 * Cualquier otro import del registro sigue entrando tal cual y `check:bundle` lo vería.
 */
const hebraDiagnosticsShim = {
  name: 'hebra-diagnostics-shim',
  setup(builder) {
    builder.onResolve({ filter: /^\.\.\/diagnostics$/ }, (args) =>
      args.importer.endsWith(join('vendor', 'hebra', 'src', 'lib', 'library', 'space-history-client.ts'))
        ? { path: join(root, 'src', 'shims', 'hebra-diagnostics.ts') }
        : undefined
    );
  }
};

const shared = {
  bundle: true,
  plugins: [hebraDiagnosticsShim],
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
  // `src/store`/`src/sync`, no de estos `dist/*`). `dist/sheets/index.js` es el núcleo de
  // hojas de Hebra (H-173): entra aquí para que `check:bundle` lo cargue sin DOM y compruebe
  // sus dependencias aunque ninguna herramienta lo use todavía.
  entryPoints: ['store', 'sync', 'lock', 'sheets'].map((dir) => join(root, 'src', dir, 'index.ts')),
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

// Hilo de la conversión de ofimática (C-27, C-38): `runOfficeConversion` lo arranca con
// `new Worker(new URL('./office-worker.mjs', import.meta.url))`, o sea `dist/office-worker.mjs`
// junto a `cli.mjs`. Entrada propia y autónoma (sin `splitting`), igual que las otras.
await build({
  ...shared,
  entryPoints: [join(root, 'src', 'office-worker.ts')],
  outfile: join(root, 'dist', 'office-worker.mjs')
});

// Hilo de los trabajos de documentos (B-LR21, B-I01): `runDocumentJob` lo arranca con
// `new Worker(new URL('./document-worker.mjs', import.meta.url))`, o sea `dist/document-worker.mjs`
// junto a `cli.mjs`. Entrada propia y autónoma, igual que `office-worker.mjs`. Los paquetes
// nativos (`@napi-rs/canvas`) quedan externos y los resuelve `node_modules` de la imagen.
await build({
  ...shared,
  entryPoints: [join(root, 'src', 'document-worker.ts')],
  outfile: join(root, 'dist', 'document-worker.mjs')
});

// Hilo del motor de fórmulas de hojas (H-173): `createNodeFormulaEngine` lo arranca con la URL
// que recibe (`new URL('./sheet-engine-worker.mjs', import.meta.url)` desde `dist/`). Entrada
// propia y autónoma: el hilo no puede cargar el servidor entero. `@ironcalc/wasm` queda externo
// y su wasm se lee de `node_modules`.
await build({
  ...shared,
  entryPoints: [join(root, 'src', 'sheet-engine-worker.ts')],
  outfile: join(root, 'dist', 'sheet-engine-worker.mjs')
});

// Fuentes de los documentos (B-LR11): las mismas del submódulo, junto a su licencia. Se maqueta
// SIEMPRE con ellas, así que un `dist/` sin la carpeta no sirve: se falla aquí y no al pintar.
const fontsSource = join(root, 'vendor', 'hebra', 'static', 'fonts', 'documents');
const fontsTarget = join(root, 'dist', 'fonts', 'documents');
if (!existsSync(fontsSource)) {
  throw new Error(`build: faltan las fuentes de documentos en ${fontsSource} (¿está inicializado el submódulo vendor/hebra?)`);
}
rmSync(fontsTarget, { recursive: true, force: true });
cpSync(fontsSource, fontsTarget, { recursive: true });
