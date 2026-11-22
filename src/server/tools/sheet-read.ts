/**
 * Lectura común de una hoja de cálculo (`.ods`) para las herramientas de hojas: `hebra_render_sheet`
 * (H-81, `./render-sheet.ts`) y `hebra_read_sheet` (H-78, `./read-sheet-job.ts`). Lo que sale de
 * aquí es el estado de ahora del documento, proyectado con el adaptador real de hojas, y las dos
 * revisiones que compara `hebra_edit_sheet` (`revision` y `layoutRevision`, decisión 18).
 *
 * Qué NO hace: privacidad. Quien llama comprueba antes que el documento se ve (`visibleDocumentOf`
 * o el filtro de ficheros de su llamada), como pide `openDocumentRead`. Tampoco escribe: ni
 * cabecera, ni punto de control, ni `files` (D28, punto 5).
 *
 * Un `.ods` sin cabecera de documento (nunca abierto en el editor) se lee desde los bytes del
 * fichero, con una de dos formas de estado (`headless`):
 * - `scaffold`: el andamio del adaptador, lo que vería quien lo abriera ahora. Es la del render:
 *   lo pintado es lo mismo que en el editor. El andamio lleva un clientID nuevo en cada lectura, así
 *   que su `revision` cambia de una llamada a otra.
 * - `empty`: un `Y.Doc` vacío, sin andamio. Es la de `hebra_read_sheet`: la misma lectura da la misma
 *   `revision`, y el modelo proyectado es el del fichero.
 */
import * as Y from 'yjs';
import type { FormulaScope } from '../../../vendor/hebra/src/lib/sheets/formula/canon';
import { newDocumentHead } from '../../../vendor/hebra/src/lib/documents/sync/lifecycle';
import { ExportOdsError } from '../../../vendor/hebra/src/lib/sheets/ods/export';
import {
  createSheetAdapter,
  OdsReadError,
  prepareSheetBase,
  type CanonFormula,
  type CellValue,
  type SheetAdapter,
  type SheetBase,
  type SheetModel,
  type SheetModelSheet
} from '../../sheets';
import type { DocumentPort } from '../../store/document-channel';
import { openDocumentRead, type DocumentRead, type DocumentReadSource } from '../../store/document-read';
import { SHEET_DOCUMENT_MAX_BYTES, SHEET_ODS_READ_LIMITS } from '../../store/sheet-limits';
import { ToolError } from '../errors';

/** Cómo se lee un `.ods` sin cabecera (ver la cabecera del fichero). */
export type HeadlessState = 'scaffold' | 'empty';

/** Un documento de hojas abierto para leer. `close` suelta el `Y.Doc`; no escribe. */
export interface OpenedSheet {
  /** Bytes del último punto de control, o de la base; sin cabecera, los del fichero. */
  base: Uint8Array;
  sheetBase: SheetBase;
  adapter: SheetAdapter;
  read: DocumentRead<SheetModel>;
  close(): Promise<void>;
}

export const isFormula = (value: CellValue | undefined): value is { f: CanonFormula } =>
  typeof value === 'object' && value !== null && 'f' in value;

/** Hoja por su nombre exacto, por su nombre sin distinguir mayúsculas o por su id. */
export function sheetOf(model: SheetModel, wanted: string): SheetModelSheet | null {
  const exact = model.sheets.find((s) => s.name === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  return model.sheets.find((s) => s.name.toLowerCase() === lower) ?? model.sheets.find((s) => s.id === wanted) ?? null;
}

/** El ámbito de una fórmula para escribir su texto, con los nombres visibles de las hojas. */
export function scopeOf(model: SheetModel, sheet: string): FormulaScope {
  return {
    sheet,
    axes: (id) => {
      const s = model.sheets.find((x) => x.id === id);
      return s ? { rows: s.rows, cols: s.cols } : null;
    },
    sheetIdByName: (name) => model.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase())?.id ?? null,
    sheetNameById: (id) => model.sheets.find((x) => x.id === id)?.name ?? null
  };
}

/** Una `DocumentReadSource` que sirve unos bytes y un estado ya leídos, sin volver al almacén. */
export function pinnedSource(
  stored: Awaited<ReturnType<DocumentPort['docRead']>>,
  sha256: string,
  bytes: Uint8Array
): DocumentReadSource {
  const port = {
    docRead: async () => stored,
    blobRead: async (wanted: string) => (wanted === sha256 ? bytes : null)
  };
  // `openDocumentRead` solo llama a `docRead` y `blobRead` (los demás métodos son de escritura).
  return { port: port as unknown as DocumentPort };
}

/** Los bytes de un blob de este dispositivo o, si la fuente sabe, bajados del relé. */
export async function blobOf(source: DocumentReadSource, sha256: string): Promise<Uint8Array | null> {
  const local = await source.port.blobRead(sha256).catch(() => null);
  return local ?? (await source.readBlob?.(sha256).catch(() => null)) ?? null;
}

/** Lo que dice `readSafeZip` al pasar un tope: mismo criterio que `zipError` de `read-workbook.ts`. */
const ZIP_LIMIT_MESSAGE = /l[ií]mite|relaci[oó]n de compresi|demasiadas entradas/i;

/**
 * Si `error` es un tope de lectura de `SHEET_ODS_READ_LIMITS` pasado (H-TOPES-MCP), que quien
 * llama responde como `document_too_complex`. Hebra lo dice de tres formas según el camino:
 * `OdsReadError` con `too_large` (el lector del libro, `prepareSheetBase`), `ExportOdsError` con
 * `unreadable` y el texto del tope (guardar, `exportOds`) y el `Error` sin tipo de `readSafeZip`
 * (las imágenes y `content.xml` de `createEditorData`, el paquete de `openSheetController`).
 */
export function isSheetLimitError(error: unknown): boolean {
  if (error instanceof OdsReadError) return error.code === 'too_large';
  if (error instanceof ExportOdsError) return error.code === 'unreadable' && ZIP_LIMIT_MESSAGE.test(error.message);
  // Solo el `Error` de `readSafeZip`, no una subclase con un texto que lo parezca.
  return error instanceof Error && error.constructor === Error && ZIP_LIMIT_MESSAGE.test(error.message);
}

/**
 * Abre el `.ods` `file` para leerlo, con los topes de hojas del MCP (`SHEET_ODS_READ_LIMITS`,
 * H-95b): el libro, el adaptador y su guardado los reciben por parámetro (H-TOPES-MCP), siempre el
 * mismo objeto, porque la caché de `prepareSheetBase` va por su identidad. Errores con código
 * cerrado (`ToolError`): cabecera de otro formato, `document_invalid`; faltan los bytes,
 * `file_unavailable`; más de `SHEET_DOCUMENT_MAX_BYTES` (4 MiB), `file_too_large`; un `.ods`
 * ilegible, `document_invalid`, o `document_too_complex` si pasa un tope de lectura.
 */
export async function openSheetRead(
  source: DocumentReadSource,
  file: { id: string; sha256: string },
  signal: AbortSignal,
  headless: HeadlessState
): Promise<OpenedSheet> {
  const stored = await source.port.docRead(file.id);
  const head = stored.head ?? newDocumentHead('ods', 'file', file.sha256);
  if (head.format !== 'ods') throw new ToolError('document_invalid');
  const baseSha = head.checkpointSha256 ?? head.baseSha256;
  const base = await blobOf(source, baseSha);
  if (!base) throw new ToolError('file_unavailable');
  if (base.byteLength > SHEET_DOCUMENT_MAX_BYTES) {
    throw new ToolError('file_too_large', { byteLength: base.byteLength, maxBytes: SHEET_DOCUMENT_MAX_BYTES });
  }
  signal.throwIfAborted();

  let sheetBase: SheetBase;
  try {
    sheetBase = await prepareSheetBase(base, SHEET_ODS_READ_LIMITS);
  } catch (error) {
    if (isSheetLimitError(error)) throw new ToolError('document_too_complex');
    if (error instanceof OdsReadError) throw new ToolError('document_invalid');
    throw error;
  }
  const adapter = createSheetAdapter(sheetBase, { limits: SHEET_ODS_READ_LIMITS });

  let state = stored;
  if (!stored.head) {
    state = { head, segments: [], pending: [], pendingSeqs: [] };
    if (headless === 'scaffold') {
      const scaffold = new Y.Doc();
      try {
        adapter.scaffold(base, scaffold);
        state = { ...state, segments: [Y.encodeStateAsUpdateV2(scaffold)] };
      } finally {
        scaffold.destroy();
      }
    }
  }
  const read = await openDocumentRead(pinnedSource(state, baseSha, base), file.id, adapter, signal);
  return { base, sheetBase, adapter, read, close: () => read.close() };
}
