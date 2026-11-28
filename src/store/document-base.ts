/**
 * Qué bytes de fichero hay debajo de un documento (`.ods`, `.odp`). Dos preguntas distintas, dos
 * funciones, y ninguna otra parte de `src/` lee `head.checkpointSha256` para abrir bytes
 * (`test/store/document-base.test.ts` lo vigila):
 *
 * - `projectionBaseSha256`: sobre qué bytes se PROYECTA, se COMPILA un lote, se APLICA y se
 *   EXPORTA. Siempre el fichero BASE de la generación (`head.baseSha256`), como la app
 *   (`vendor/hebra/src/lib/documents/kinds/ods/editor.ts`, `openOdsDocument` y
 *   `createOdsExporter`). El estado del documento vive en el `Y.Doc` con ids relativos a ESA base:
 *   las hojas que vienen del fichero se llaman `s<índice>` por su posición en él
 *   (`vendor/hebra/src/lib/sheets/ods/read-workbook.ts`). Un punto de control
 *   (`checkpointSha256`) es la base con el `Y.Doc` ya dentro: proyectar el `Y.Doc` encima lo
 *   superpone dos veces (hojas repetidas «X (2)») y los ids por posición apuntan a otras hojas
 *   (borrar `s2` hace desaparecer la siguiente, una fórmula `='Hoja'!A1` da «Hoja desconocida» y
 *   un lote escribe en filas que la base no tiene, así que no sale al exportar).
 *
 * - `exposedBytesSha256`: los bytes de fichero que el documento ENSEÑA hoy (el último punto de
 *   control o, sin ninguno, la base). Solo para la privacidad (regla (b) de D10: si una nota
 *   oculta enlaza esos bytes, el documento no se lee), nunca para abrir bytes.
 */
import type { DocHeadRecord } from '../../vendor/hebra/src/lib/documents/contract';

/** Los bytes sobre los que se proyecta, compila, aplica y exporta: la base de la generación. */
export function projectionBaseSha256(head: Pick<DocHeadRecord, 'baseSha256'>): string {
  return head.baseSha256;
}

/** Los bytes de fichero que enseña el documento, para la regla (b) de privacidad. No se abren. */
export function exposedBytesSha256(head: Pick<DocHeadRecord, 'baseSha256' | 'checkpointSha256'>): string {
  return head.checkpointSha256 ?? head.baseSha256;
}
