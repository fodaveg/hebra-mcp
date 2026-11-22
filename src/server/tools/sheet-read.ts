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
import { readSafeZip } from '../../../vendor/hebra/src/lib/portability/zip-read';
import { zipLimits } from '../../../vendor/hebra/src/lib/sheets/ods/read-workbook';
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

/** Las partes del paquete que lee `readOdsWorkbook` (su `select`). */
const WORKBOOK_PARTS = new Set(['content.xml', 'mimetype', 'settings.xml', 'styles.xml']);

/**
 * Las partes XML del libro con los topes de hojas del MCP (`SHEET_ODS_READ_LIMITS`, H-95b): 4 MiB
 * descomprimidos en total. `prepareSheetBase` de Hebra lee con los topes de S-F (256 MiB) y no los
 * acepta por parámetro, así que se miran aquí antes, con las mismas partes, y el descompresor corta
 * al pasar del tope sin inflar el resto. Un tope pasado es `document_too_complex`; un ZIP roto se
 * deja para el lector, que dice `document_invalid`.
 */
export async function assertSheetReadLimits(base: Uint8Array): Promise<void> {
  try {
    await readSafeZip(base, zipLimits(SHEET_ODS_READ_LIMITS), { select: (path) => WORKBOOK_PARTS.has(path) });
  } catch (error) {
    // Mismo criterio que `zipError` de `read-workbook.ts`: los de tope se distinguen por el texto.
    const message = error instanceof Error ? error.message : '';
    if (/l[ií]mite|relaci[oó]n de compresi|demasiadas entradas/i.test(message)) throw new ToolError('document_too_complex');
  }
}

/**
 * Abre el `.ods` `file` para leerlo. Errores con código cerrado (`ToolError`): cabecera de otro
 * formato, `document_invalid`; faltan los bytes, `file_unavailable`; más de
 * `SHEET_DOCUMENT_MAX_BYTES` (4 MiB), `file_too_large`; un `.ods` ilegible, `document_invalid`, o
 * `document_too_complex` si pasa un tope de lectura (`assertSheetReadLimits` o el del lector).
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
  await assertSheetReadLimits(base);
  signal.throwIfAborted();

  let sheetBase: SheetBase;
  try {
    sheetBase = await prepareSheetBase(base);
  } catch (error) {
    if (error instanceof OdsReadError) {
      throw new ToolError(error.code === 'too_large' ? 'document_too_complex' : 'document_invalid');
    }
    throw error;
  }
  const adapter = createSheetAdapter(sheetBase);

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
