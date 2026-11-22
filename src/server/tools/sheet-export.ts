/**
 * El exportador de documentos del escritor (H-BLOQUEO-SYNC): lo que `setDocumentExporter`
 * (`../../store/document-channel.ts`) necesita para que el punto de control tras un lote, el
 * `ensureCheckpoint` de duplicar y las generaciones del cableado escriban un `.ods` al día. Sin él,
 * los tres fallan con `document-export-unavailable`: el lote se aplica, pero `files.sha256` sigue
 * en la última versión guardada y duplicar da `file_unavailable`.
 *
 * Es el exportador de `.ods` del núcleo (`createOdsExporter`, `vendor/hebra/src/lib/documents/
 * kinds/ods/editor.ts`) con las mismas piezas: el `Y.Doc` con los segmentos, los pendientes y el
 * `recent` del `/h`, el adaptador de hojas sobre el fichero BASE (`head.baseSha256`) y su
 * `exportFile`. Determinista: el mismo estado da los mismos bytes, así que un documento sin
 * cambios no crea punto de control. No se importa ese módulo tal cual porque arrastra el
 * componente del editor (`import('./OdsEditorHost.svelte')` y los tipos de `svelte`), que ni
 * esbuild ni tsc resuelven aquí. `test/tools/sheet-export.test.ts` comprueba que los dos dan los
 * mismos bytes.
 *
 * La caché de las fórmulas editadas la calcula el motor de Node (el mismo hilo que el informe de
 * `hebra_edit_sheet`); si el motor no arranca, esas fórmulas se guardan sin caché, como en el
 * núcleo sin motor, y LibreOffice las calcula al abrir. Solo `.ods`: otro formato responde
 * `document-export-unavailable`, que el punto de control trata como pendiente.
 */
import * as Y from 'yjs';
import { createNodeFormulaEngine, createSheetAdapter, prepareSheetBase, type FormulaEngine } from '../../sheets';
import { setDocumentExporter, type DocumentExporter } from '../../store/document-channel';
import { SHEET_ODS_INVENTORY_LIMITS, SHEET_ODS_READ_LIMITS } from '../../store/sheet-limits';

const ENGINE_WORKER_URL = new URL('./sheet-engine-worker.mjs', import.meta.url);

export interface SheetDocumentExporterOptions {
  /** Motor de fórmulas para la caché. Por defecto, el de Node con el hilo empaquetado. */
  engine?: () => FormulaEngine;
}

/** El exportador de `.ods` (ver la cabecera). Lanza, sin devolver bytes viejos, si falta la base. */
export function createSheetDocumentExporter(options: SheetDocumentExporterOptions = {}): DocumentExporter {
  const engine = options.engine ?? (() => createNodeFormulaEngine({ workerUrl: ENGINE_WORKER_URL }));
  return async (context, fileId, head) => {
    if (head.format !== 'ods') throw new Error('document-export-unavailable');
    const base = await context.blobRead(head.baseSha256);
    if (!base) throw new Error('blob_missing');
    const read = await context.store.docRead(fileId);
    const recent = (read.head ?? head).recent;
    const doc = new Y.Doc();
    try {
      for (const update of [...read.segments, ...read.pending]) Y.applyUpdateV2(doc, update);
      if (recent !== '') Y.applyUpdateV2(doc, new Uint8Array(Buffer.from(recent, 'base64')));
      // Los topes de hojas del MCP, los mismos objetos que la lectura común (H-TOPES-MCP): el libro
      // con los de lectura y el guardado, que descomprime también las imágenes, con los del
      // inventario (motivo en `sheet-limits.ts`). Un `.ods` que los pasa no se exporta: el
      // exportador lanza, como con cualquier otro fallo de lectura.
      const adapter = createSheetAdapter(await prepareSheetBase(base, SHEET_ODS_READ_LIMITS), {
        engine,
        limits: SHEET_ODS_INVENTORY_LIMITS
      });
      const bytes = await adapter.exportFile(base, doc, new AbortController().signal);
      return { bytes, referencedBlobs: adapter.referencedBlobs(doc) };
    } finally {
      doc.destroy();
    }
  };
}

let registered = false;

/**
 * Registra el exportador de `.ods` una sola vez por proceso. Lo llama `localWriteContext` de
 * `../serve.ts`, junto al formato de hojas (`registerSheetDocumentFormat`): el escritor exporta
 * aunque no tenga ninguna sesión MCP abierta.
 */
export function registerSheetDocumentExporter(): void {
  if (registered) return;
  registered = true;
  setDocumentExporter(createSheetDocumentExporter());
}
