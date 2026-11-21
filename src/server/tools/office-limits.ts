/**
 * Límites de `hebra_import_office` (C-25, medidos en C-07). Un solo sitio para las cifras, porque
 * C-27 reserva memoria con ellas en el `CapacityGate` y C-28 las documenta.
 *
 * La regla es UNA conversión a la vez (C-27). Medición de C-07 (21 nov 2026,
 * `scripts/mem/office-25mib.mjs`): `readSafeZip` (solo las partes `.xml`, con `select`) y `decodeXml`
 * en la imagen de producción (Node 24.21.0), `--memory=512m --memory-swap=512m`, 220 MiB de lastre
 * (el MCP vivo, D22) y un ZIP de 25 MiB (XML muy comprimible más una imagen incompresible). Tres
 * corridas por fila; criterio fijado antes de medir: sin OOM y `maxRSS` de 460 MiB o menos en las
 * tres. La base sin conversiones es de 333 MiB de RSS. La imagen es arm64 y corre emulada en el
 * Fedora (amd64), que suma unos 55 MiB al RSS frente a Node 22 nativo: la medición es prudente.
 *
 *   XML expandido   maxRSS (3 corridas)   pico del cgroup
 *   8 MiB           434, 434, 433         385 MiB
 *   10 MiB          441, 441, 443         394 MiB
 *   12 MiB          450, 451, 450         399 MiB   <- el mayor que cumple
 *   14 MiB          463, 463, 463         412 MiB   (no cumple)
 *   16 MiB          479, 478, 478         429 MiB   (no cumple)
 *
 * Con un ZIP de 1 MiB y 12 MiB de XML el RSS es de 435 MiB: lo que pesa es el XML expandido, no el
 * tamaño del archivo. Un ZIP de 25 MiB cumple, así que el tope de `fileId` es de 25 MiB; lo que
 * acota la memoria es `OFFICE_ZIP_LIMITS`, que `readSafeZip` aplica antes de expandir (con los
 * topes de defecto, 512 MiB, un fichero muy comprimible mataría el contenedor).
 */
const MIB = 1024 * 1024;

/** Tope de un Office por `fileId` o `dataBase64`, ya decodificado: 25 MiB, el de la extensión de
 *  compartir. Cumple el criterio de memoria de C-07 si los topes del ZIP son `OFFICE_ZIP_LIMITS`. */
export const OFFICE_FILE_ID_MAX_BYTES = 25 * MIB;

/** Lo máximo que acepta `dataBase64` una vez decodificado. Hoy, el mismo tope que `fileId`. */
export const OFFICE_DATA_MAX_BYTES = OFFICE_FILE_ID_MAX_BYTES;

/**
 * Topes de descompresión de un Office para `readSafeZip` (C-27 los pasa). Mismos campos que
 * `DEFAULT_ZIP_LIMITS` de Hebra (`zip-read.ts`) y ninguno mayor: lo comprueba
 * `scripts/mem/office-25mib.mjs comprobar-limites`. Se escriben a mano porque importar el valor
 * arrastraría `fflate`, que declara C-38. C-27 debe pasar `select` con solo las partes XML.
 */
export const OFFICE_ZIP_LIMITS = {
  maxArchiveBytes: OFFICE_FILE_ID_MAX_BYTES,
  maxEntries: 20_000,
  maxFileBytes: 12 * MIB,
  maxExpandedBytes: 12 * MIB,
  maxCompressionRatio: 200
} as const;

/**
 * Lo que reserva cada conversión en el `CapacityGate` mientras corre: 120 MiB. Es el peor caso
 * medido con los topes anteriores (ZIP de 25 MiB y 12 MiB de XML): 451 MiB de RSS menos la base de
 * 333 MiB son 118 MiB.
 */
export const OFFICE_CONVERSION_RESERVE_BYTES = 120 * MIB;
