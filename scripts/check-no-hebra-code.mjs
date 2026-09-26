#!/usr/bin/env node
/**
 * Criterio de cierre de L0 (SPEC.md §10, D5): ni una línea de Hebra (privado, sin
 * licencia) versionada en hebra-mcp (público) fuera del submódulo `vendor/hebra`.
 *
 * Método: el hash de blob de git (SHA-1 de `blob <bytes>\0<contenido>`, lo que ya
 * calcula `git hash-object`/`git ls-tree`) identifica un contenido byte a byte, sin
 * mirar la ruta ni la extensión. Se listan los blobs de TODO el árbol de `vendor/hebra`
 * en el SHA fijado y se compara contra el hash del contenido ACTUAL (no solo el
 * commiteado: también lo que está en el árbol de trabajo sin confirmar) de cada fichero
 * que git seguiría fuera de `vendor/`. Un blob vacío (fichero de 0 bytes) se ignora:
 * coincidiría con cualquier otro fichero vacío del submódulo sin que eso sea copiar
 * nada.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'vendor', 'hebra');
/** Blob de git de un fichero vacío: siempre el mismo hash, no es una coincidencia real. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Blobs de todo el árbol del submódulo, en el SHA fijado (su HEAD).
const vendorBlobs = new Map(); // sha de blob -> una ruta de ejemplo dentro de vendor/hebra
for (const line of git(['ls-tree', '-r', 'HEAD'], vendorDir).trim().split('\n')) {
  if (!line) continue;
  const [, , sha, path] = line.split(/\s+/);
  if (sha === EMPTY_BLOB) continue;
  if (!vendorBlobs.has(sha)) vendorBlobs.set(sha, path);
}

// Ficheros que git sigue en hebra-mcp, fuera del gitlink del submódulo.
const tracked = git(['ls-files'], root)
  .trim()
  .split('\n')
  .filter((path) => path && path !== 'vendor/hebra' && !path.startsWith('vendor/hebra/'));

const matches = [];
for (const relPath of tracked) {
  const fullPath = join(root, relPath);
  let sha;
  try {
    sha = git(['hash-object', fullPath], root).trim();
  } catch {
    continue; // borrado en el árbol de trabajo pero aún en el índice: no hay contenido que comparar.
  }
  if (sha === EMPTY_BLOB) continue;
  const vendorPath = vendorBlobs.get(sha);
  if (vendorPath) matches.push({ own: relPath, vendor: vendorPath });
}

if (matches.length > 0) {
  console.error('check:no-hebra-code: contenido idéntico al de vendor/hebra fuera del submódulo:');
  for (const match of matches) {
    console.error(`  ${match.own}  ==  vendor/hebra/${match.vendor}`);
  }
  process.exit(1);
}

console.log(
  `check:no-hebra-code: ${tracked.length} fichero(s) versionado(s) fuera de vendor/, ninguno idéntico a un blob de Hebra.`
);
