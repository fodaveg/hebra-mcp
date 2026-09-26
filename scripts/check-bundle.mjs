#!/usr/bin/env node
/**
 * Criterio de cierre de L0, ampliado en L3 (SPEC.md §10): el bundle de `dist/` no puede
 * traer nada que dependa de Tauri, de SvelteKit (`$app/…`, `svelte`) o del DOM:
 * hebra-mcp corre en Node puro, sin navegador. Se comprueba sobre el JS YA empaquetado,
 * no sobre las fuentes: lo que importa es lo que de verdad queda después de que esbuild
 * siga los imports.
 *
 * L3 mete en el bundle el analizador Markdown de Hebra (`deriveNote` → `notes/markdown.ts`
 * → `@codemirror/lang-markdown`, que arrastra `@codemirror/view`), porque la paridad de
 * derivados con las apps es obligatoria (decisión del orquestador, 26 sep 2026). Ese
 * código tiene referencias REALES a `document`/`window`/`navigator`, protegidas con
 * `typeof … !== 'undefined'`. Cómo se admite sin abrir la puerta a nada más:
 *
 * 1. Imports prohibidos (`@tauri-apps/…`, `$app/…`, `svelte`, `@sveltejs/…`): se leen
 *    del metafile de esbuild (cada import, externo o empaquetado, con su ruta), no con
 *    un grep de texto, y además se buscan como texto en `dist/` por si llegan como
 *    cadena a un `import()` dinámico.
 * 2. Globales del DOM: `scripts/build.mjs` deja los paquetes de `node_modules` como
 *    externos, así que en `dist/` solo hay código de hebra-mcp y de Hebra. Aquí se
 *    reempaqueta cada fichero de `dist/` en memoria, METIENDO todos los paquetes de
 *    `node_modules` salvo `@codemirror/*` y `@lezer/*` (los únicos exentos), con un
 *    `define` que sustituye cada global (`window`, `document`, `navigator`,
 *    `indexedDB`…, también como `globalThis.x`) por un centinela. `define` de esbuild
 *    solo sustituye referencias LIBRES, no variables locales, así que una variable
 *    `document` de `notes/markdown.ts` (medido: tres apariciones de `document.` que son
 *    un parámetro, no el DOM) no da un falso positivo, y un `window.` real en cualquier
 *    otro paquete sí aparece. Un solo centinela en la salida = fallo, con el fichero de
 *    origen (el comentario `// ruta` que esbuild pone delante de cada módulo).
 * 3. Prueba de humo: carga `dist/*` en un proceso de Node SIN globales del DOM (se
 *    borra el `navigator` que trae Node 24 y se comprueba que `window`, `document` y
 *    `navigator` son `undefined`) y ejecuta `deriveNote` sobre un Markdown con H1,
 *    `#etiqueta/anidada` y `[[enlace]]`, comparando con la salida esperada de Hebra.
 *
 * `zod` (peer del SDK de MCP, L1) también queda exento: `zod/v4/core/util.js` tiene
 * `if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare"))`
 * (detecta el runtime de Cloudflare Workers para su mapa de errores), protegido con
 * `typeof` igual que el caso de CodeMirror de arriba — decisión del orquestador, 26 sep
 * 2026, tras medirlo con este mismo check.
 *
 * `debug` y `object-inspect` entran con Express (C2, `serve-http`: el router OAuth del SDK
 * de MCP es de Express) y quedan exentos por la misma razón, medido con este check el 26
 * sep 2026:
 * - `debug/src/index.js` solo carga `browser.js` (el que usa `window`, `document`,
 *   `navigator` y `localStorage`) si `typeof process === 'undefined'` o el proceso es un
 *   renderer de Electron o NW.js; en Node carga `node.js`.
 * - `object-inspect/index.js:255`: `typeof window !== 'undefined' && obj === window`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');

/** Texto que no puede aparecer en `dist/` (imports que llegaran como cadena). */
const FORBIDDEN_TEXT = ['@tauri-apps', '$app/'];
/** Especificadores de import prohibidos (metafile). */
const FORBIDDEN_IMPORT = /^(@tauri-apps\/|\$app\/|svelte(\/|$)|@sveltejs\/)/;
/** Paquetes exentos del chequeo de globales del DOM (y solo estos). */
const DOM_EXEMPT_PACKAGES = [
  '@codemirror/*',
  '@lezer/*',
  'zod',
  'zod/*',
  'debug',
  'debug/*',
  'object-inspect',
  'object-inspect/*'
];
/** Externos en el reempaquetado para que un import prohibido que no esté instalado
 *  aparezca en el metafile (y se informe) en vez de romper la resolución. */
const FORBIDDEN_EXTERNALS = ['@tauri-apps/*', '$app/*', 'svelte', 'svelte/*', '@sveltejs/*'];
/** Externos en el reempaquetado porque son módulos NATIVOS (`.node`), que esbuild no
 *  sabe cargar: `@napi-rs/keyring` (llavero del SO, L2) y su binario por plataforma. No
 *  llevan JS de navegador que mirar: el cargador de `index.js` solo elige el `.node`. */
const NATIVE_EXTERNALS = ['@napi-rs/keyring', '@napi-rs/keyring-*'];
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
  excerpt: 'Ideas para #viajes/2026 y enlace a Otra nota.',
  tags: [
    { tag: 'viajes', label: 'viajes' },
    { tag: 'viajes/2026', label: 'viajes/2026' }
  ],
  links: [{ targetKind: 'title', target: 'otra nota', targetPath: null }],
  blobRefs: [],
  props: []
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
process.stdout.write(JSON.stringify(withDerive.deriveNote(${JSON.stringify(SAMPLE)})));
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

if (failed) process.exit(1);
console.log(
  `check:bundle: ${files.length} fichero(s) de dist/ sin imports de Tauri/$app/svelte, sin globales del DOM fuera de ${DOM_EXEMPT_PACKAGES.join(' y ')}, y deriveNote carga y deriva en Node sin DOM.`
);
