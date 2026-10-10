#!/usr/bin/env node
/**
 * Criterio de cierre de L0 (SPEC.md §10, D5): ni una línea de Hebra (privado, sin
 * licencia) versionada en hebra-mcp (público) fuera del submódulo `vendor/hebra`. Dos
 * comprobaciones, cada una pensada para el fallo que la otra no ve:
 *
 * 1. Blob idéntico (de siempre): el hash de blob de git (SHA-1 de
 *    `blob <bytes>\0<contenido>`, lo que ya calcula `git hash-object`/`git ls-tree`)
 *    identifica un contenido byte a byte, sin mirar la ruta ni la extensión. Se listan
 *    los blobs de TODO el árbol de `vendor/hebra` en el SHA fijado y se compara contra el
 *    hash del contenido ACTUAL (no solo el commiteado: también lo que está en el árbol
 *    de trabajo sin confirmar) de cada fichero que git seguiría fuera de `vendor/`. Un
 *    blob vacío (fichero de 0 bytes) se ignora: coincidiría con cualquier otro fichero
 *    vacío del submódulo sin que eso sea copiar nada.
 *
 * 2. Solapamiento de líneas (26 sep 2026, D5): un fichero PROPIO puede compartir código
 *    de Hebra sin ser BYTE A BYTE idéntico a ninguno de sus ficheros (imports propios
 *    delante o detrás, un comentario distinto): así llegó a `test/library-cases.
 *    node.test.ts` a compartir 90 de sus 112 líneas con el dispatcher privado de
 *    `library-cases.test.ts` de Hebra sin que el check de blobs lo viera. Aquí se cuentan
 *    las líneas SIGNIFICATIVAS (recortadas de espacios, más de `SIGNIFICANT_LINE_LEN`
 *    caracteres: una línea corta, un `}` o un `return null;` sueltos, aparece en
 *    cualquier fichero de cualquier proyecto y no es indicio de copia) de cada fichero
 *    propio que APARECEN TAL CUAL (mismo texto recortado) en algún fichero de
 *    `vendor/hebra/src` o `vendor/hebra/src-tauri/src` (los dos motores, TS y Rust).
 *    Un fichero legítimo que solo importa de Hebra y llama a sus funciones con la firma
 *    correcta comparte un puñado de líneas (imports, una firma de función, un literal de
 *    ruta); un fichero que copió su lógica comparte decenas.
 *
 *    Umbral (`MAX_SHARED_LINES`), medido el 26 sep 2026 con este mismo algoritmo (script
 *    de medida ad hoc, borrado tras medir, no versionado): los ficheros propios
 *    legítimos comparten entre 9 y 15 líneas así (`test/sync/sync-runner.node.test.ts`,
 *    el máximo, por sus imports y la firma de `SyncRunner.create`/`NoteWriter`); el
 *    dispatcher que motivó esta regla compartía 80 (medido contra Hebra en `199c3d1d`;
 *    90 los citó David contra el SHA de entonces, `035db7e6`). Prueba negativa: 40
 *    líneas seguidas de código denso de `sqlite-engine.ts` (JSDoc + cuerpo de
 *    `libraryRestorePendingBatch`) comparten 35. `MAX_SHARED_LINES = 25` deja un margen
 *    de +10 sobre el máximo legítimo medido, por debajo de una copia real de 40 líneas
 *    (35) y muy por debajo del caso que motivó la regla (80): un fichero que lo cruce no
 *    es un import de más, es una copia.
 *
 *    Desde el 10 oct 2026 las líneas de Hebra incluyen también `scripts/sonda-d` (el
 *    prototipo de la opción D, que `src/workdir/` reimplementa desde el contrato). Prueba
 *    negativa medida ese día en `59b5d403`, con un script ad hoc no versionado: 60 líneas
 *    seguidas de `hebra-d.ts` (desde la 753, el principio de `commandApply`; 33
 *    significativas) en un fichero propio registrado con `git add -N` comparten 33 y el
 *    check sale rojo («src/zz-sonda-probe.ts (33 líneas compartidas)»); contadas solo
 *    contra `src` y `src-tauri/src`, como antes, compartían 2 y pasaban. Con este cambio,
 *    `src/store/node-port.ts` sube de 23 a 24 (una firma) y lo de `src/workdir/` queda
 *    entre 1 y 9.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorDir = join(root, 'vendor', 'hebra');
/** Blob de git de un fichero vacío: siempre el mismo hash, no es una coincidencia real. */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
/** Más de esta longitud (tras recortar espacios) para contar como línea significativa. */
const SIGNIFICANT_LINE_LEN = 30;
/** Líneas significativas compartidas con Hebra que tolera un fichero propio (ver §2 de
 *  arriba: medido entre 9 y 15 en los legítimos de hoy, +10 de margen). */
const MAX_SHARED_LINES = 25;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Ficheros que git sigue en hebra-mcp, fuera del gitlink del submódulo.
const tracked = git(['ls-files'], root)
  .trim()
  .split('\n')
  .filter((path) => path && path !== 'vendor/hebra' && !path.startsWith('vendor/hebra/'));

// --- 1. Blob idéntico -------------------------------------------------------------

// Blobs de todo el árbol del submódulo, en el SHA fijado (su HEAD).
const vendorBlobs = new Map(); // sha de blob -> una ruta de ejemplo dentro de vendor/hebra
for (const line of git(['ls-tree', '-r', 'HEAD'], vendorDir).trim().split('\n')) {
  if (!line) continue;
  const [, , sha, path] = line.split(/\s+/);
  if (sha === EMPTY_BLOB) continue;
  if (!vendorBlobs.has(sha)) vendorBlobs.set(sha, path);
}

const blobMatches = [];
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
  if (vendorPath) blobMatches.push({ own: relPath, vendor: vendorPath });
}

// --- 2. Solapamiento de líneas -----------------------------------------------------

function significantLines(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > SIGNIFICANT_LINE_LEN);
}

// Todas las líneas significativas de los dos motores de Hebra (TS y Rust), en un solo
// set: no hace falta saber DE QUÉ fichero viene una línea para decidir que se comparte.
// Desde el 10 oct 2026 también las del prototipo de la opción D (`scripts/sonda-d`,
// `hebra-d.ts` y su arnés): `src/workdir/` reimplementa lo mismo desde el contrato, y una
// copia del prototipo tiene que saltar aquí igual que una del motor (prueba negativa en la
// cabecera).
const vendorLines = new Set();
const vendorSourceDirs = ['src', join('src-tauri', 'src'), join('scripts', 'sonda-d')];
for (const line of git(['ls-tree', '-r', '--name-only', 'HEAD'], vendorDir).trim().split('\n')) {
  if (!vendorSourceDirs.some((dir) => line.startsWith(`${dir}/`))) continue;
  let text;
  try {
    text = readFileSync(join(vendorDir, line), 'utf8');
  } catch {
    continue; // binario o borrado en el árbol de trabajo del submódulo: no aporta líneas.
  }
  for (const shared of significantLines(text)) vendorLines.add(shared);
}

const lineMatches = [];
for (const relPath of tracked) {
  let text;
  try {
    text = readFileSync(join(root, relPath), 'utf8');
  } catch {
    continue; // binario o borrado en el árbol de trabajo: no hay líneas que contar.
  }
  const shared = significantLines(text).filter((line) => vendorLines.has(line)).length;
  if (shared > MAX_SHARED_LINES) lineMatches.push({ path: relPath, shared });
}

// --- Veredicto ----------------------------------------------------------------------

if (blobMatches.length > 0 || lineMatches.length > 0) {
  if (blobMatches.length > 0) {
    console.error('check:no-hebra-code: contenido idéntico al de vendor/hebra fuera del submódulo:');
    for (const match of blobMatches) {
      console.error(`  ${match.own}  ==  vendor/hebra/${match.vendor}`);
    }
  }
  if (lineMatches.length > 0) {
    console.error(
      `check:no-hebra-code: fichero(s) con más de ${MAX_SHARED_LINES} líneas significativas ` +
        'compartidas con vendor/hebra (posible copia, aunque no sea idéntico byte a byte):'
    );
    for (const match of lineMatches) {
      console.error(`  ${match.path}  (${match.shared} líneas compartidas)`);
    }
  }
  process.exit(1);
}

console.log(
  `check:no-hebra-code: ${tracked.length} fichero(s) versionado(s) fuera de vendor/, ninguno idéntico ` +
    `a un blob de Hebra ni por encima de ${MAX_SHARED_LINES} líneas significativas compartidas.`
);
