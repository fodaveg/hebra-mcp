/**
 * Topes de las hojas de cálculo (`.ods`) en el MCP (H-95, V-01 del estudio MCP de documentos),
 * fijados con la medida de memoria del hilo de lectura real. Sustituyen, para hojas, a las cifras
 * provisionales de `./document-limits.ts` (25 MiB por documento, reserva de `2 x tamaño + 64 MiB`
 * y 2 trabajos a la vez) y a los topes de lectura de la premisa S-F del plan de hojas
 * (`ODS_READ_LIMITS` de Hebra: 256 MiB descomprimidos, 128 MiB por entrada), que no caben.
 *
 * Cómo se midió (22 nov 2026, Mac, Docker 29.9.3 arm64 nativo). La sonda corre `runDocumentJob`
 * de `./document-jobs.ts` con el `Worker` de `dist/document-worker.mjs` y su `resourceLimits`,
 * la lectura de `hebra_read_sheet` (página `A1:H250` con valores y fórmulas, y resumen del libro)
 * y el motor IronCalc en su hilo (`dist/sheet-engine-worker.mjs`). Contenedor con el Node de la
 * imagen de producción (24.21.0), `--memory=512m --memory-swap=512m` como `deploy/compose.yml`, y
 * 220 MiB de lastre tocado: el MCP vivo con dos cuentas (D22 midió 219,5 MiB, igual que C-07). Se
 * lee el pico de `memory.peak` del cgroup. Los `.ods` los genera la sonda sobre la plantilla de
 * LibreOffice del submódulo: filas de 8 celdas (4 números, 2 textos, 1 fecha y 1 fórmula), con lo
 * que falta hasta el tamaño pedido en una imagen incompresible. Criterio fijado antes de medir: sin
 * OOM y pico del cgroup de 409,6 MiB o menos (el 80 % de 512 MiB, `DEFAULT_HIGH_WATER`) en las
 * tres corridas de cada modo.
 *
 * 1. Sin `--liftoff-only`, ningún libro con fórmulas cabe: con UN trabajo y sin lastre, 18 de 19
 *    corridas de 0,13 a 25 MiB murieron por OOM; con el lastre, las 20 con fórmulas (1 y 2 trabajos) acabaron en OOM (una llegó a responder, con el pico en 436 MiB).
 *    El pico es transitorio y no es del documento: la compilación optimizada (TurboFan) del wasm de
 *    IronCalc en cada hilo nuevo del motor. IronCalc solo, 1000 filas con fórmula en el hilo
 *    principal: el RSS pasa de 73 a 562 MiB con el heap de JS en 5 MiB y la memoria del wasm en 2,
 *    y con `--liftoff-only` no pasa de 98 MiB. Puesto desde el código con `v8.setFlagsFromString`
 *    no sirve (4 de 4 corridas en OOM): tiene que ir en la línea de `node`.
 * 2. Con `--liftoff-only`, un trabajo, pico del cgroup en MiB (tres corridas, página y resumen):
 *
 *      .ods     XML      antes   pico página        pico resumen       cumple
 *      0,01     0,05     233     346, 346, 346      347, 346, 344      sí
 *      4        2        241     376, 379, 377      377, 392, 378      sí
 *      4        4        241     391, 393, 391      405, 393, 391      sí   <- los topes
 *      8        2        249     398, 395, 397      394, 398, 411      no
 *      8        4        249     408, 407, 409      408, 410, 410      no
 *      2        8        237     413, 412, 414      412, 413, 412      no
 *      4        8        241     423, 419, 419      418, 419, 420      no
 *      12       4        257     424, 423, 422      424, 422, 424      no
 *      25       2        283     460                464                no
 *
 *    El mayor incremento dentro de los topes es de 163,6 MiB (4 MiB de `.ods` y 4 de XML, resumen).
 *    La lectura más lenta dentro de los topes tardó 2,1 s, bajo el plazo de 10 s.
 * 3. Dos trabajos a la vez en los topes (4 y 4 MiB), con `--liftoff-only`: picos de 512, 501, 512,
 *    485 y 476 MiB y un OOM en seis corridas. No caben: la reserva tiene que dejarlos de uno en uno.
 * 4. Con los topes ya cableados (H-95b, 22 nov 2026, la misma sonda y el mismo contenedor): un
 *    `.ods` de 4 MiB con 3,9 MiB de `content.xml` da picos de 390,3, 391,8 y 390,4 MiB (página) y
 *    391,7, 390,9 y 390,6 (resumen); el de 0,01 MiB, de 345 a 350. El de 4 MiB con 4 MiB de
 *    `content.xml` de la tabla del punto 2 ya no se lee: con `styles.xml` y `settings.xml` pasa de los
 *    4 MiB en total y da `document_too_complex` en 0,3 s, con el pico en 301 MiB. Sin
 *    `--liftoff-only`, el de 3,9 MiB vuelve a morir por OOM (salida 137).
 *
 * No medido aquí: la edición (`hebra_edit_sheet` proyecta y exporta en el hilo principal), el
 * pintado (`hebra_render_sheet`), un servidor con otro número de núcleos y libros reales de
 * usuarios. La edición y la fase de lectura del pintado abren el mismo libro con la misma lectura
 * común (`openSheetRead`) y el mismo motor, así que apartan la misma reserva que la lectura.
 *
 * Por parámetro a Hebra (H-TOPES-MCP): el libro (`prepareSheetBase`), los datos del pintado
 * (`createEditorData`, también las imágenes) y la lengua del libro (`readBookSettings`,
 * `readBookLocale`) leen con `SHEET_ODS_READ_LIMITS`, siempre el mismo objeto, porque la caché de
 * `prepareSheetBase` va por su identidad. El adaptador (`createSheetAdapter`, en `sheet-read.ts`,
 * `sheet-export.ts` y `create-sheet.ts`) recibe `SHEET_ODS_INVENTORY_LIMITS`: su guardado
 * (`exportOds`) descomprime TODAS las entradas del paquete, imágenes incluidas, y con los de
 * lectura un `.ods` bajo `SHEET_DOCUMENT_MAX_BYTES` que se lee no se podría guardar (medido: uno de
 * 4.071.603 bytes con una imagen de 3,3 MiB y un SVG de 1 MiB se lee y no se exporta). Hebra pide
 * en `SheetAdapterOptions.limits` los mismos topes que en `prepareSheetBase` porque `baseFor`
 * relee con ellos los bytes base que no son los del adaptador; el MCP siempre exporta con los
 * bytes con que creó el adaptador, nunca pasa por esa relectura, así que la diferencia no cambia
 * lo que se lee.
 *
 * Dónde se aplican (H-95b): `../server/tools/sheet-read.ts` (el tope de tamaño y los de lectura,
 * para las tres herramientas), `../server/tools/read-sheet-job.ts` (estilos e inventario),
 * `./sheet-jobs.ts` (un trabajo a la vez y la reserva, para leer, pintar y editar),
 * `../server/tools/{read,edit,render}-sheet.ts` (`file_too_large`) y `deploy/Dockerfile`
 * (`--liftoff-only` en la línea de `node`, que comprueba `test/deploy/deploy-config.test.ts`).
 */
import type { OdsReadLimits } from '../../vendor/hebra/src/lib/sheets/contracts/limits';

const MIB = 1024 * 1024;

/** Memoria del contenedor del MCP (`mem_limit` de `deploy/compose.yml`). */
export const SHEET_CONTAINER_BYTES = 512 * MIB;

/** Presupuesto: el 80 % del contenedor, el mismo `DEFAULT_HIGH_WATER` de la compuerta. */
export const SHEET_MEMORY_BUDGET_BYTES = Math.floor(SHEET_CONTAINER_BYTES * 0.8);

/**
 * Lo que ya está en uso antes del trabajo, medido: el MCP vivo con dos cuentas (lastre de
 * 220 MiB), Node con el servidor cargado y un `.ods` del tope leído. Base del cálculo de cuántos
 * trabajos caben, no una cifra que use la compuerta (ella mide la suya).
 */
export const SHEET_MCP_BASE_BYTES = 241 * MIB;

/** Tamaño máximo de un `.ods` que el MCP abre como hoja. Más da `file_too_large`. */
export const SHEET_DOCUMENT_MAX_BYTES = 4 * MIB;

/**
 * Topes de lectura del `.ods` en el MCP, para `readOdsWorkbook` (`options.limits`): las partes
 * XML elegidas (`content.xml`, `styles.xml`, `settings.xml`) no pasan de 4 MiB descomprimidas en
 * total. Ninguno es mayor que los de S-F (`ODS_READ_LIMITS`) ni que los de `C-02`
 * (`DEFAULT_ZIP_LIMITS`): lo comprueba su test.
 */
export const SHEET_ODS_READ_LIMITS: Readonly<OdsReadLimits> = Object.freeze({
  maxTotalBytes: 4 * MIB,
  maxEntryBytes: 4 * MIB,
  maxRatio: 200,
  maxEntries: 10_000
});

/**
 * Topes del inventario del resumen (`inventoryOds`, lo que se conserva sin entender): ese lector
 * descomprime TODAS las entradas del paquete, no solo las partes XML, porque busca macros, firmas
 * y objetos por su ruta. Lo que no es XML (imágenes, miniatura) va casi siempre guardado sin
 * comprimir y ocupa como mucho lo que el `.ods`, así que el total es el de las partes XML más el
 * del documento: 8 MiB. Un `.ods` legítimo cabe; una bomba se corta ahí, y el resumen sale sin
 * inventario, como cualquier fallo de ese lector. Es menos de lo que se midió, que leía el
 * inventario con
 * `DEFAULT_ZIP_LIMITS` sobre un `.ods` cuyo relleno es una imagen sin comprimir. Son también los
 * del guardado del adaptador (`exportOds`), que descomprime el paquete entero por lo mismo
 * (H-TOPES-MCP, ver la cabecera).
 */
export const SHEET_ODS_INVENTORY_LIMITS: Readonly<OdsReadLimits> = Object.freeze({
  ...SHEET_ODS_READ_LIMITS,
  maxTotalBytes: SHEET_ODS_READ_LIMITS.maxTotalBytes + SHEET_DOCUMENT_MAX_BYTES
});

/**
 * Lo que aparta en la compuerta cada trabajo de hojas mientras corre: el mayor incremento medido
 * dentro de los topes (163,6 MiB), redondeado a 8 MiB. Es fijo y no depende del tamaño: el motor
 * pesa más que el documento, y un `.ods` pequeño puede llevar los 4 MiB de XML.
 */
export const SHEET_JOB_RESERVE_BYTES = 168 * MIB;

/**
 * Reserva de un trabajo de hojas sobre un `.ods` de `documentBytes`. Por encima del tope no hay
 * reserva que valga: quien llama tiene que haber respondido `file_too_large` antes.
 */
export function sheetJobReserveBytes(documentBytes: number): number {
  if (!(documentBytes <= SHEET_DOCUMENT_MAX_BYTES)) {
    throw new RangeError('sheet_document_too_large');
  }
  return SHEET_JOB_RESERVE_BYTES;
}

/** Cuántos trabajos de hojas caben a la vez con la base medida: uno. */
export const SHEET_JOBS_MAX = Math.floor((SHEET_MEMORY_BUDGET_BYTES - SHEET_MCP_BASE_BYTES) / SHEET_JOB_RESERVE_BYTES);

/**
 * Opciones de `node` sin las que estos topes no valen (punto 1 de la cabecera). Van en la línea
 * de arranque del servidor, no en `NODE_OPTIONS` ni con `v8.setFlagsFromString`.
 */
export const SHEET_ENGINE_NODE_FLAGS = ['--liftoff-only'] as const;

/** Versiones que retiene el `/h` (`VERSIONS_MAX` de Hebra, `documents/sync/checkpoint.ts`). */
export const SHEET_RETAINED_VERSIONS = 120;

/**
 * Disco máximo de un documento con la limpieza de `B-N21`: las versiones retenidas, la base y el
 * punto de control actual. Medido el 22 nov 2026 con `takeCheckpoint` real y `FsBlobStore` en
 * disco, 130 puntos con acuse tras cada uno:
 *
 *      .ods     sin limpieza          con limpieza           con limpieza, acuse cada 4
 *      25 MiB   130 blobs, 3250 MiB   122 blobs, 3025 MiB    36 blobs, 875 MiB
 *      4 MiB                          122 blobs, 484 MiB
 *
 * Con 48 puntos (un día a uno cada 30 min) y acuse tras cada uno no se borra nada: 1200 MiB con y
 * sin limpieza. La limpieza solo libera los puntos sustituidos sin acuse y las versiones que pasan
 * de 120; lo que acota el disco por documento es `VERSIONS_MAX` por el tamaño del documento.
 */
export const SHEET_DISK_PER_DOCUMENT_MAX_BYTES = (SHEET_RETAINED_VERSIONS + 2) * SHEET_DOCUMENT_MAX_BYTES;
