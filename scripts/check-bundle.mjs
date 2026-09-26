#!/usr/bin/env node
/**
 * Criterio de cierre de L0 (SPEC.md §10): el bundle de `dist/` no puede traer nada que
 * dependa de Tauri, de SvelteKit (`$app/…`) o del DOM: hebra-mcp corre en Node puro, sin
 * navegador. Un grep de texto sobre el JS ya empaquetado, no sobre las fuentes: lo que
 * importa es lo que de verdad queda dentro después de que esbuild siga los imports.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');

const FORBIDDEN = [
  '@tauri-apps',
  '$app/',
  'window.',
  'document.',
  'navigator.',
  'indexedDB',
  'FileSystemSyncAccessHandle'
];

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJsFiles(full));
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);
  }
  return out;
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
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      console.error(`check:bundle: ${relative(root, file)} contiene la referencia prohibida "${needle}"`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(`check:bundle: ${files.length} fichero(s) de dist/ sin referencias a Tauri, $app ni DOM.`);
