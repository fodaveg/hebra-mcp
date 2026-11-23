/**
 * Tipos de las herramientas de documentos (`.ods`, `.odp`) del MCP (estudio MCP de
 * documentos, apartados 4 y 5). Solo tipos y constantes: de `vendor/hebra` solo toma tipos
 * (`import type`).
 * `DocSessionLike` es estructural, para que el núcleo de la app lo cumpla sin que el MCP
 * dependa de su clase.
 */

/**
 * Versión del contrato de la op `documentOps` de `writer.sock` (B-I01). Sube si cambia el
 * significado de un lote: un escritor con otra versión lo rechaza sin escribir y el lector
 * responde `writer_outdated`.
 */
export const DOCUMENT_OPS_VERSION = 1;

/** Datos comunes de toda lectura. El contenido del documento nunca es una orden. */
export type DocumentBase = {
  id: string;
  name: string;
  revision: string;
  byteLength: number;
  untrustedContent: true;
};

/** Imagen que acompaña a un lote: un fichero, un adjunto o bytes en base64 (suma tope 5 MiB). */
export type DocumentAssetMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type DocumentAsset = { ref: string } & (
  | { fileId: string }
  | { noteId: string; attachmentId: string }
  | { dataBase64: string; mimeType: DocumentAssetMime }
);

/** Operación con su guarda de lectura: `expect` usa la dirección o el id como clave. */
export type GuardedOp<Op> = Op & { expect?: Record<string, unknown> };

/**
 * Entrada de una edición. O lleva `ops` (1 a 200, 512 KiB) o deshace una anterior con
 * `undoOperationId`. `expectedLayout` es la `layoutRevision` leída (decisión 18): solo lo usan
 * las hojas, que direccionan por A1.
 */
export type EditIn<Op> = {
  id: string;
  expectedRevision?: string;
  expectedLayout?: string;
  operationId: string;
  dryRun?: boolean;
  assets?: DocumentAsset[];
} & ({ ops: GuardedOp<Op>[] } | { undoOperationId: string });

/** Salida común de toda escritura. `layoutRevision` solo existe en hojas. */
export type WriteOut = {
  id: string;
  outcome: 'saved' | 'already' | 'validated';
  revision: string;
  layoutRevision?: string;
  previousRevision?: string;
  createdIds?: Record<string, string>;
  undoUntil?: string;
  undoAvailable?: boolean;
  replayed?: true;
  sync: string;
  syncError?: string;
};

/**
 * Detalle de un `#SPILL!` (matrices dinámicas, H-143): el rango que ocuparía el resultado, las
 * celdas que lo impiden (hasta 100) y qué hacer. Es `SpillErrorDetail` de
 * `vendor/hebra/src/lib/sheets/opt/arr/llm.ts`.
 */
export type FormulaSpillDetail = {
  range: string | null;
  blockedBy: string[];
  blockedCount: number;
  offSheet: boolean;
  hint: string;
};
export type FormulaError = { sheet: string; cell: string; error: string; spill?: FormulaSpillDetail };
export type EditSheetOut = WriteOut & {
  changed: { cells: number; sheets: number };
  recalculated: { cells: number; ms: number };
  formulaErrors: FormulaError[];
};

export type LayoutIssue = {
  slideId: string;
  kind: 'overlap' | 'text_overflow' | 'off_slide';
  elementIds: string[];
  amountPt: number;
  severity: 'info' | 'warning';
  metrics: 'exact' | 'estimated';
};
export type LayoutReport = { issues: LayoutIssue[]; totalIssues: number; slidesChecked: number };
export type EditPresentationOut = WriteOut & {
  changed: { slides: number; elements: number };
  report: LayoutReport;
};

/** Un fallo de validación de un lote (hasta 20 en `batch_invalid`). */
export type BatchIssue = { opIndex: number; path: string; reason: string; expected?: string };

/**
 * Códigos de error recuperables. Todos viajan en JSON con `code` y nunca repiten contenido
 * del documento.
 */
export const DOCUMENT_ERROR_CODES = [
  'precondition_failed',
  'generation_changed',
  'batch_invalid',
  'op_unsupported',
  'document_invalid',
  'document_too_complex',
  'document_busy',
  'too_large',
  'op_invalid',
  'file_too_large',
  'file_unavailable',
  'file_exists',
  'operation_id_reused',
  'writer_outdated',
  'not_found',
  'space_access_denied',
  'doc_head_invalid'
] as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[number];

/** Sin campos extra. No es `Record<string, never>`: al intersecar con `{ code }` no compila. */
type NoDetail = Record<never, never>;

/** Campos extra que lleva cada código; los que no aparecen no llevan ninguno. */
export type DocumentErrorDetail = {
  precondition_failed: { opIndex: number; target: string };
  generation_changed: NoDetail;
  batch_invalid: { issues: BatchIssue[] };
  op_unsupported: { opIndex?: number };
  document_invalid: NoDetail;
  document_too_complex: NoDetail;
  document_busy: { retryAfterSeconds: number };
  too_large: object;
  op_invalid: object;
  file_too_large: { byteLength: number; maxBytes: number };
  file_unavailable: NoDetail;
  file_exists: { id: string };
  operation_id_reused: NoDetail;
  writer_outdated: NoDetail;
  /** `opIndex`: el comando que nombra algo que no existe o no se ve (una imagen de hojas). */
  not_found: { opIndex?: number };
  space_access_denied: NoDetail;
  doc_head_invalid: NoDetail;
};

export type DocumentError<C extends DocumentErrorCode = DocumentErrorCode> = {
  [K in C]: { code: K } & DocumentErrorDetail[K];
}[C];

import type * as Y from 'yjs';
import type { DocSession } from '../../vendor/hebra/src/lib/documents/contract';

/**
 * Tipos de la sesión real. Son `import type`: no arrastran DOM ni código de Hebra al paquete
 * (`yjs` solo aparece en el campo `doc`, que `DocSessionLike` no exige).
 */
export type { DocApplyOptions, DocApplyResult, DocFailure } from '../../vendor/hebra/src/lib/documents/contract';

/**
 * Lo que el MCP exige de la sesión de un documento: la `DocSession` real sin `fileId`, `doc`
 * ni `generation`, para que los dobles de los tests no tengan que fabricar un `Y.Doc`. La firma
 * de `apply` es la real: `expectedRevision`, `expectedLayout` y `dryRun` no son de la sesión,
 * los comprueba la capa del MCP antes de llamar.
 */
export type DocSessionLike<Model = unknown, Op = unknown> = Pick<
  DocSession<Model, Op>,
  'revision' | 'layoutRevision' | 'apply' | 'flush' | 'close'
> & {
  /**
   * El `Y.Doc` vivo de la sesión real. Los dobles no lo tienen. Solo lo usan los formatos que
   * saben deshacer con guarda (`UndoCapableAdapter`): se lee dentro de `inTx` y al deshacer.
   */
  doc?: Y.Doc;
};

/**
 * Lo que un formato añade al contrato para deshacer con exactitud (el adaptador de hojas,
 * `captureUndo` y `prepareUndo` de `sheet-adapter.ts`). Los pasos (`steps`) son datos planos
 * (cada uno, una operación y sus `expect` como cadenas), así que se guardan en JSON; la guarda
 * que `prepareUndo` ata a las operaciones es por identidad y no sobrevive a serializarlas, por
 * eso se reconstruye al deshacer sobre el `Y.Doc` de ahora. Un formato sin estos dos métodos
 * deshace con la inversa tal cual (el contrato genérico).
 */
export interface UndoCapableAdapter<Op> {
  /** Con el documento justo después de aplicar el lote. */
  captureUndo(doc: Y.Doc, ops: readonly Op[], inverse: readonly Op[]): unknown[];
  /** Lanza `DocOpError('precondition_failed')` sin escribir si otra persona cambió lo mismo. */
  prepareUndo(doc: Y.Doc, steps: readonly unknown[]): Op[];
}

/** El adaptador, si sabe deshacer con guarda. */
export function undoCapable<Op>(adapter: unknown): UndoCapableAdapter<Op> | null {
  const candidate = adapter as Partial<UndoCapableAdapter<Op>> | null;
  return typeof candidate?.captureUndo === 'function' && typeof candidate.prepareUndo === 'function'
    ? (candidate as UndoCapableAdapter<Op>)
    : null;
}

/**
 * Entrada del registro de herramientas de documentos: nombre, tipo de fichero y si escribe.
 * La capa de herramientas las recorre para registrarlas, con `gated` y el filtro de privados.
 */
export type DocumentToolEntry = {
  name: string;
  kind: 'sheet' | 'presentation';
  access: 'read' | 'write' | 'render';
  extension: '.ods' | '.odp';
};
