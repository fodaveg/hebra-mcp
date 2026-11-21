/**
 * Límites de `hebra_import_office` (C-25). Un solo sitio para las cifras, porque C-07 las
 * sustituye por las medidas en un contenedor de 512 MiB y C-28 las documenta.
 */

/** Tope PROVISIONAL de un Office por `fileId` o `dataBase64`, ya decodificado: 25 MiB, el
 *  mismo que la extensión de compartir. C-07 lo cambia por el tope efectivo medido. */
export const OFFICE_FILE_ID_MAX_BYTES = 25 * 1024 * 1024;

/** Lo máximo que acepta `dataBase64` una vez decodificado. Hoy, el mismo tope que `fileId`. */
export const OFFICE_DATA_MAX_BYTES = OFFICE_FILE_ID_MAX_BYTES;
