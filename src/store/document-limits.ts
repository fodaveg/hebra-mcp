/**
 * Topes de las herramientas de documentos (`.ods`, `.odp`) del MCP (estudio MCP de
 * documentos, apartado 4). Son del servidor, no de Hebra: no importan nada de `vendor/hebra`.
 * Las cifras de Yjs y del relé de la app viven en `src/lib/documents/limits.ts` de Hebra; aquí
 * solo se repite lo que el MCP necesita para rechazar antes de abrir el documento.
 */

const KIB = 1024;
const MIB = 1024 * KIB;

/** Tamaño máximo de un documento. Provisional: reserva de 114 MiB, bajo el 80 % de 512 MiB. */
export const DOCUMENT_MAX_BYTES = 25 * MIB;
/** Partes XML descomprimidas en total, comprobado antes de inflar. */
export const DOCUMENT_XML_INFLATED_MAX_BYTES = 64 * MIB;
/** Heap del hilo que proyecta y valida. A medir en V-01. */
export const DOCUMENT_WORKER_HEAP_MAX_BYTES = 128 * MIB;

/** Trabajos de documentos a la vez por proceso (las conversiones siguen a 1). */
export const DOCUMENT_JOBS_MAX = 2;
/** Espera en cola antes de `document_busy`, en ms. */
export const DOCUMENT_QUEUE_WAIT_MS = 20_000;
/** Plazo para leer y pintar, en ms. Se corta con `terminate()`. */
export const DOCUMENT_READ_TIMEOUT_MS = 10_000;
/** Plazo para editar, en ms. Se corta con `terminate()`. */
export const DOCUMENT_EDIT_TIMEOUT_MS = 15_000;

/** Caracteres de una respuesta, bajo el aviso de 10.000 tokens. */
export const DOCUMENT_RESPONSE_MAX_CHARS = 30_000;

/** Operaciones por lote de edición. */
export const EDIT_OPS_MAX = 200;
export const EDIT_OPS_MIN = 1;
/** Bytes del lote de operaciones serializado. */
export const EDIT_OPS_MAX_BYTES = 512 * KIB;
/** Tope de `batch_invalid`: entradas de `issues`. */
export const BATCH_INVALID_ISSUES_MAX = 20;
/** Tope de `formulaErrors` y de `LayoutReport.issues`. */
export const REPORT_ISSUES_MAX = 50;

/** Suma de los `dataBase64` de los `assets` de una llamada, en bytes decodificados. */
export const ASSETS_MAX_BYTES = 5 * MIB;

/** Deshacer: vigencia, entradas y bytes por entrada. Si no cabe, `undoAvailable: false`. */
export const UNDO_MAX_AGE_DAYS = 7;
export const UNDO_MAX_ENTRIES = 200;
export const UNDO_ENTRY_MAX_BYTES = 1 * MIB;

/** Lectura de hojas: celdas por llamada (1 a 2000, 500 por defecto). */
export const READ_SHEET_MAX_CELLS = 2000;
export const READ_SHEET_DEFAULT_CELLS = 500;

/** Imagen renderizada: lado largo, ancho pedido y número por llamada. */
export const RENDER_LONG_SIDE_MAX_PX = 1568;
export const RENDER_WIDTH_MIN_PX = 320;
export const RENDER_WIDTH_MAX_PX = 1568;
export const RENDER_WIDTH_DEFAULT_PX = 960;
export const RENDER_SLIDES_MAX = 4;
/** Rango máximo de `hebra_render_sheet`. */
export const RENDER_SHEET_MAX_COLUMNS = 60;
export const RENDER_SHEET_MAX_ROWS = 200;
