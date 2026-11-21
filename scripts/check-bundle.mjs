#!/usr/bin/env node
/**
 * Criterio de cierre de L0, ampliado en L3 (SPEC.md §10): el bundle de `dist/` no puede
 * traer nada que dependa de Tauri, de SvelteKit (`$app/…`, `svelte`) o del DOM:
 * hebra-mcp corre en Node puro, sin navegador. Se comprueba sobre el JS YA empaquetado,
 * no sobre las fuentes: lo que importa es lo que de verdad queda después de que esbuild
 * siga los imports.
 *
 * L3 mete en el bundle el analizador Markdown de Hebra (`deriveNote` → `notes/markdown.ts`),
 * porque la paridad de derivados con las apps es obligatoria (decisión del orquestador, 26
 * sep 2026). Desde el submódulo en `2acb6d4b` (27 sep 2026), ese analizador parsea con
 * `@lezer/markdown` directo (`markdown/dialect.ts` de Hebra), sin `@codemirror/lang-markdown`
 * ni `@codemirror/view`: ninguno de los `@lezer/*` que arrastra referencia el DOM (medido con
 * este mismo check quitándolos de `DOM_EXEMPT_PACKAGES` y viendo que sigue en verde), así que
 * ya no necesitan quedar exentos del paso 2. Cómo se admite el resto sin abrir la puerta a nada más:
 *
 * 1. Imports prohibidos (`@tauri-apps/…`, `$app/…`, `svelte`, `@sveltejs/…`): se leen
 *    del metafile de esbuild (cada import, externo o empaquetado, con su ruta), no con
 *    un grep de texto, y además se buscan como texto en `dist/` por si llegan como
 *    cadena a un `import()` dinámico.
 * 2. Globales del DOM: `scripts/build.mjs` deja los paquetes de `node_modules` como
 *    externos, así que en `dist/` solo hay código de hebra-mcp y de Hebra. Aquí se
 *    reempaqueta cada fichero de `dist/` en memoria, METIENDO todos los paquetes de
 *    `node_modules` salvo los de `DOM_EXEMPT_PACKAGES` (`zod`, `debug`, `object-inspect`;
 *    § comentarios de abajo), con un `define` que sustituye cada global (`window`,
 *    `document`, `navigator`, `indexedDB`…, también como `globalThis.x`) por un centinela.
 *    `define` de esbuild solo sustituye referencias LIBRES, no variables locales, así que
 *    un `window.` o `document.` real en cualquier paquete no exento sí aparece. Un solo
 *    centinela en la salida = fallo, con el fichero de origen (el comentario `// ruta` que
 *    esbuild pone delante de cada módulo).
 * 3. Prueba de humo: carga `dist/*` en un proceso de Node SIN globales del DOM (se
 *    borra el `navigator` que trae Node 24 y se comprueba que `window`, `document` y
 *    `navigator` son `undefined`) y ejecuta `deriveNote` sobre un Markdown con H1,
 *    `#etiqueta/anidada` y `[[enlace]]`, comparando con la salida esperada de Hebra.
 *    Desde H-173 carga también el núcleo de hojas (`dist/sheets/index.js`), comprueba que
 *    exporta una pieza de cada paquete de Hebra que lo forma (`SHEETS_CORE_EXPORTS`) y arranca
 *    el motor de fórmulas en su hilo empaquetado (`dist/sheet-engine-worker.mjs`), que tiene que
 *    calcular una fórmula. Las dependencias del núcleo (`@ironcalc/wasm`, `harfbuzzjs`,
 *    `linebreak`) las vigila R27 como las demás: pasar una a `devDependencies` da rojo aquí.
 *
 * `zod` (peer del SDK de MCP, L1) queda exento: `zod/v4/core/util.js` tiene
 * `if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare"))`
 * (detecta el runtime de Cloudflare Workers para su mapa de errores), protegido con
 * `typeof` — decisión del orquestador, 26 sep 2026, tras medirlo con este mismo check.
 *
 * `debug` y `object-inspect` entran con Express (C2, `serve-http`: el router OAuth del SDK
 * de MCP es de Express) y quedan exentos por la misma razón, medido con este check el 26
 * sep 2026:
 * - `debug/src/index.js` solo carga `browser.js` (el que usa `window`, `document`,
 *   `navigator` y `localStorage`) si `typeof process === 'undefined'` o el proceso es un
 *   renderer de Electron o NW.js; en Node carga `node.js`.
 * - `object-inspect/index.js:255`: `typeof window !== 'undefined' && obj === window`.
 *
 * `yjs` y su dependencia `lib0` entran con D25 (9 nov 2026, RT-4 de Hebra: el motor de Hebra
 * combina las ediciones de una nota de espacio con un `Y.Text`, y esbuild las resuelve desde
 * el `package.json` de hebra-mcp). Quedan exentos por la misma razón, medido con este check:
 * - `lib0/environment.js` y `lib0/storage.js`: `typeof window/document/navigator/localStorage
 *   !== 'undefined'` antes de cada uso (el módulo detecta el entorno).
 * - `yjs/dist/yjs.mjs`: `typeof window !== 'undefined'` para elegir el global, y `document`
 *   solo como valor por defecto del parámetro de `toDOM` de los tipos XML, que hebra-mcp no
 *   llama (solo usa `Y.Text`); la prueba de humo del paso 3 lo carga sin DOM.
 */
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');

/** Entrada del hilo de ofimática (C-27, C-38): `runOfficeConversion` la arranca como Worker. */
const OFFICE_WORKER = join(distDir, 'office-worker.mjs');
/** Entrada del hilo de documentos (B-LR21, B-I01): `runDocumentJob` la arranca como Worker. */
const DOCUMENT_WORKER = join(distDir, 'document-worker.mjs');
/** Núcleo de hojas de Hebra (H-173): lo que usan las herramientas de hojas, sin DOM. */
const SHEETS_CORE = join(distDir, 'sheets', 'index.js');
/** Hilo del motor de fórmulas de hojas (H-173): `createNodeFormulaEngine` lo arranca por su URL. */
const SHEET_ENGINE_WORKER = join(distDir, 'sheet-engine-worker.mjs');
/** Lo que `dist/sheets/index.js` tiene que exportar: una pieza por paquete de Hebra del núcleo. */
const SHEETS_CORE_EXPORTS = [
  'createSheetAdapter', // H-31
  'prepareSheetBase', // H-31
  'applySheetOp', // H-31
  'compileBatch', // H-30
  'layoutRevision', // H-176
  'checkExpectedLayout', // H-176
  'writeNewOds', // H-23
  'createSheetEngineProjection', // H-29
  'createNodeFormulaEngine', // H-09
  'layoutDrawList', // H-76
  'drawToSvg' // H-77
];
/** Fuentes de los documentos, junto a su licencia (B-LR11): se maqueta siempre con ellas. */
const FONTS_DIR = join(distDir, 'fonts', 'documents');
/** Paquetes que `dist/` carga sin que un `import` estático los delate (el hilo de render los
 *  resuelve con `createRequire`): deben figurar igualmente en `dependencies` (R27). */
const RUNTIME_ONLY_DEPENDENCIES = ['@napi-rs/canvas'];

/** Texto que no puede aparecer en `dist/` (imports que llegaran como cadena). */
const FORBIDDEN_TEXT = ['@tauri-apps', '$app/'];
/** Especificadores de import prohibidos (metafile). */
const FORBIDDEN_IMPORT = /^(@tauri-apps\/|\$app\/|svelte(\/|$)|@sveltejs\/)/;
/** Paquetes exentos del chequeo de globales del DOM (y solo estos). */
const DOM_EXEMPT_PACKAGES = [
  'zod',
  'zod/*',
  'debug',
  'debug/*',
  'object-inspect',
  'object-inspect/*',
  'yjs',
  'yjs/*',
  'lib0',
  'lib0/*',
  // B-LR21: `harfbuzzjs` (medida de texto de los documentos) trae un cargador de WASM de
  // Emscripten que mira `window`/`document` solo tras comprobar el entorno. Es la ÚNICA
  // exención nueva; si el paquete aún no está instalado, no cambia nada.
  'harfbuzzjs',
  'harfbuzzjs/*'
];
/** Externos en el reempaquetado para que un import prohibido que no esté instalado
 *  aparezca en el metafile (y se informe) en vez de romper la resolución. */
const FORBIDDEN_EXTERNALS = ['@tauri-apps/*', '$app/*', 'svelte', 'svelte/*', '@sveltejs/*'];
/** Externos en el reempaquetado porque son módulos NATIVOS (`.node`), que esbuild no
 *  sabe cargar: `@napi-rs/keyring` (llavero del SO, L2) y su binario por plataforma. No
 *  llevan JS de navegador que mirar: el cargador de `index.js` solo elige el `.node`. */
const NATIVE_EXTERNALS = ['@napi-rs/keyring', '@napi-rs/keyring-*', '@napi-rs/canvas', '@napi-rs/canvas-*'];
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'indexedDB',
  'localStorage',
  'sessionStorage',
  'FileSystemSyncAccessHandle'
];
const SENTINEL_PREFIX = '__HEBRA_MCP_DOM_GLOBAL__';

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/** El módulo de origen de la posición `index`: el último `// ruta` antes de ella. */
function sourceOf(text, index) {
  const before = text.slice(0, index);
  const matches = [...before.matchAll(/^\/\/ (\S+)$/gm)];
  return matches.length > 0 ? matches[matches.length - 1][1] : '(desconocido)';
}

let files;
try {
  files = listJsFiles(distDir);
} catch (error) {
  console.error(`check:bundle: no se pudo leer ${distDir} (¿corrió "npm run build" antes?): ${error.message}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`check:bundle: ${distDir} no tiene ningún .js; nada que comprobar.`);
  process.exit(1);
}

let failed = false;
const fail = (message) => {
  console.error(`check:bundle: ${message}`);
  failed = true;
};
if (!files.includes(OFFICE_WORKER)) fail(`falta ${relative(root, OFFICE_WORKER)}, la entrada del hilo de ofimática`);
if (!files.includes(DOCUMENT_WORKER)) fail(`falta ${relative(root, DOCUMENT_WORKER)}, la entrada del hilo de documentos`);
if (!files.includes(SHEETS_CORE)) fail(`falta ${relative(root, SHEETS_CORE)}, el núcleo de hojas`);
if (!files.includes(SHEET_ENGINE_WORKER)) {
  fail(`falta ${relative(root, SHEET_ENGINE_WORKER)}, la entrada del hilo del motor de hojas`);
}
if (!existsSync(join(FONTS_DIR, 'OFL-carlito.txt')) || readdirSync(FONTS_DIR).filter((n) => n.endsWith('.woff')).length === 0) {
  fail(`faltan las fuentes (.woff) y sus licencias en ${relative(root, FONTS_DIR)}`);
}

// R27: todo paquete que `dist/` importa, y los que carga sin `import` estático, figuran en
// `dependencies` (la imagen instala con `npm ci --omit=dev`: un paquete en `devDependencies` no llega).
const declared = new Set(Object.keys(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}));
const packageOf = (specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
for (const name of RUNTIME_ONLY_DEPENDENCIES) {
  if (!declared.has(name)) fail(`"${name}" no está en dependencies de package.json y dist/ lo carga en el hilo de render`);
}
for (const file of files) {
  const shallow = await build({
    entryPoints: [file],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent'
  });
  for (const info of Object.values(shallow.metafile.outputs)) {
    for (const entry of info.imports) {
      if (!entry.external || entry.path.startsWith('node:') || entry.path.startsWith('.') || entry.path.startsWith('/')) continue;
      const pkg = packageOf(entry.path);
      if (!declared.has(pkg) && !builtinModules.includes(pkg)) {
        fail(`${relative(root, file)} importa "${pkg}", que no figura en dependencies de package.json`);
      }
    }
  }
}

const define = {};
for (const name of DOM_GLOBALS) {
  define[name] = `${SENTINEL_PREFIX}${name}`;
  define[`globalThis.${name}`] = `${SENTINEL_PREFIX}${name}`;
}

for (const file of files) {
  const rel = relative(root, file);
  const text = readFileSync(file, 'utf8');

  // 1. Texto prohibido en el artefacto tal cual.
  for (const needle of FORBIDDEN_TEXT) {
    if (text.includes(needle)) fail(`${rel} contiene la referencia prohibida "${needle}"`);
  }

  // 2. Reempaquetado con todos los paquetes dentro salvo los exentos.
  let result;
  try {
    result = await build({
      entryPoints: [file],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      write: false,
      metafile: true,
      logLevel: 'silent',
      external: [...DOM_EXEMPT_PACKAGES, ...FORBIDDEN_EXTERNALS, ...NATIVE_EXTERNALS],
      define
    });
  } catch (error) {
    fail(`${rel}: no se pudo reempaquetar para el chequeo: ${error.message}`);
    continue;
  }
  const [output] = result.outputFiles;
  const bundled = output.text;
  let index = bundled.indexOf(SENTINEL_PREFIX);
  const seen = new Set();
  while (index >= 0) {
    const name = /^[A-Za-z_]+/.exec(bundled.slice(index + SENTINEL_PREFIX.length))?.[0];
    const key = `${sourceOf(bundled, index)} → ${name}`;
    if (!seen.has(key)) {
      seen.add(key);
      fail(`${rel}: referencia al global del DOM "${name}" desde ${sourceOf(bundled, index)}`);
    }
    index = bundled.indexOf(SENTINEL_PREFIX, index + 1);
  }
  for (const [input, info] of Object.entries(result.metafile.inputs)) {
    if (/node_modules\/(@tauri-apps|svelte|@sveltejs)\//.test(input)) {
      fail(`${rel} empaqueta un módulo prohibido: ${input}`);
    }
    for (const entry of info.imports) {
      if (FORBIDDEN_IMPORT.test(entry.path) || FORBIDDEN_IMPORT.test(entry.original ?? '')) {
        fail(`${rel}: ${input} importa "${entry.original ?? entry.path}"`);
      }
    }
  }
}

// 3. Prueba de humo en Node sin DOM.
const SAMPLE = '# Plan de viaje\n\nIdeas para #viajes/2026 y enlace a [[Otra nota]].\n';
const EXPECTED = {
  title: 'Plan de viaje',
  titleNorm: 'plan de viaje',
  titleSort: 'qlan de wiaje',
  excerpt: 'Ideas para #viajes/2026 y enlace a Otra nota.',
  tags: [
    { tag: 'viajes', label: 'viajes', direct: false },
    { tag: 'viajes/2026', label: 'viajes/2026', direct: true }
  ],
  links: [{ targetKind: 'title', target: 'otra nota', targetPath: null }],
  blobRefs: [],
  props: [],
  hasOpenTasks: false,
  tasks: [],
  locked: false,
  searchBody: null
};
const smoke = `
delete globalThis.navigator;
for (const name of ['window', 'document', 'navigator']) {
  if (typeof globalThis[name] !== 'undefined') throw new Error('global del DOM presente: ' + name);
}
const urls = ${JSON.stringify(files.map((file) => pathToFileURL(file).href))};
const modules = [];
for (const url of urls) modules.push(await import(url));
const withDerive = modules.find((mod) => typeof mod.deriveNote === 'function');
if (!withDerive) throw new Error('ningún fichero de dist/ exporta deriveNote');
// C-38: el hilo de ofimática carga sin DOM (en el hilo principal parentPort es null y no
// arranca solo) y exporta su manejador.
const officeUrl = ${JSON.stringify(pathToFileURL(OFFICE_WORKER).href)};
const officeModule = await import(officeUrl);
if (typeof officeModule.handleOfficeJob !== 'function') {
  throw new Error('dist/office-worker.mjs no exporta handleOfficeJob');
}
// B-LR21: el hilo de documentos carga sin DOM y responde con un código cerrado.
const documentModule = await import(${JSON.stringify(pathToFileURL(DOCUMENT_WORKER).href)});
if (typeof documentModule.handleDocumentJob !== 'function') {
  throw new Error('dist/document-worker.mjs no exporta handleDocumentJob');
}
const unknownReply = await documentModule.handleDocumentJob('no-existe', null);
if (unknownReply?.ok !== false || unknownReply.code !== 'document_job_unknown_kind') {
  throw new Error('respuesta inesperada del hilo de documentos: ' + JSON.stringify(unknownReply));
}
// Y arranca de verdad como hilo: con el registro vacío o con convertidor, debe responder UN
// mensaje cerrado ({ ok } y, si falla, un código), no colgarse ni morir.
const { Worker } = await import('node:worker_threads');
const reply = await new Promise((resolve, reject) => {
  const worker = new Worker(new URL(officeUrl), {
    execArgv: [],
    workerData: { kind: 'analyze', input: { format: 'docx', bytes: new Uint8Array(0), fileName: 'x.docx' } }
  });
  const timer = setTimeout(() => reject(new Error('el hilo no respondió en 20 s')), 20000);
  worker.once('message', (message) => { clearTimeout(timer); resolve(message); void worker.terminate(); });
  worker.once('error', (error) => { clearTimeout(timer); reject(error); });
});
if (typeof reply?.ok !== 'boolean' || (reply.ok === false && typeof reply.code !== 'string')) {
  throw new Error('respuesta inesperada del hilo: ' + JSON.stringify(reply));
}
process.stdout.write(JSON.stringify(withDerive.deriveNote(${JSON.stringify(SAMPLE)})));
`;
// H-173: el núcleo de hojas carga sin DOM con sus piezas, y el motor calcula de verdad en su hilo
// empaquetado (el wasm de IronCalc se resuelve desde node_modules, como en la imagen). Va en otro
// proceso, sin `--input-type=module`: el hilo del motor hereda los `execArgv` del proceso y
// `createNodeFormulaEngine` no deja quitarlos, así que con esa opción el hilo no arrancaría
// (`ERR_INPUT_TYPE_NOT_ALLOWED`). El servidor de verdad no la lleva.
const sheetsSmoke = `
delete globalThis.navigator;
(async () => {
  for (const name of ['window', 'document', 'navigator']) {
    if (typeof globalThis[name] !== 'undefined') throw new Error('global del DOM presente: ' + name);
  }
  const sheets = await import(${JSON.stringify(pathToFileURL(SHEETS_CORE).href)});
  for (const name of ${JSON.stringify(SHEETS_CORE_EXPORTS)}) {
    if (typeof sheets[name] !== 'function') throw new Error('dist/sheets/index.js no exporta ' + name);
  }
  const engine = sheets.createNodeFormulaEngine({
    workerUrl: new URL(${JSON.stringify(pathToFileURL(SHEET_ENGINE_WORKER).href)})
  });
  try {
    const book = {
      locale: 'en',
      timezone: 'UTC',
      sheets: [{ name: 'Hoja 1', cells: [{ row: 0, col: 0, input: '2' }, { row: 0, col: 1, input: '=A1*21' }] }]
    };
    await engine.load(book, { locale: book.locale, timezone: book.timezone }, new AbortController().signal);
    const values = await engine.readValues(0, { from: { row: 0, col: 1 }, to: { row: 0, col: 1 } });
    if (values.length !== 1 || values[0].value !== 42) {
      throw new Error('el motor de hojas de dist/ no calculó =A1*21: ' + JSON.stringify(values));
    }
  } finally {
    engine.dispose();
  }
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
`;
try {
  const stdout = execFileSync(
    process.execPath,
    ['--no-warnings', '--input-type=module', '-e', smoke],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const actual = JSON.parse(stdout);
  if (!isDeepStrictEqual(actual, EXPECTED)) {
    fail(
      `deriveNote del bundle no coincide con lo esperado:\n  esperado ${JSON.stringify(EXPECTED)}\n  obtenido ${JSON.stringify(actual)}`
    );
  }
} catch (error) {
  fail(`la prueba de humo (cargar dist/ sin DOM y derivar) falló:\n${error.stderr ?? error.message}`);
}
try {
  execFileSync(process.execPath, ['--no-warnings', '-e', sheetsSmoke], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Por encima del plazo de carga del motor (`ENGINE_LOAD_MS`, 60 s): un hilo que no responde
    // lo rechaza el propio motor con su código, no este corte.
    timeout: 120_000
  });
} catch (error) {
  fail(`la prueba de humo del núcleo de hojas (cargar sin DOM y calcular en el hilo del motor) falló:\n${error.stderr || error.message}`);
}

if (failed) process.exit(1);
console.log(
  `check:bundle: ${files.length} fichero(s) de dist/ sin imports de Tauri/$app/svelte, sin globales del DOM fuera de ${DOM_EXEMPT_PACKAGES.join(' y ')}, deriveNote carga y deriva en Node sin DOM, y el núcleo de hojas carga y su motor calcula en su hilo.`
);
