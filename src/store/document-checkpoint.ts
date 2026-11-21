/**
 * Punto de control de un documento (`.ods`, `.odp`) tras un lote del LLM (paquete B-N14, decisión
 * 6 del plan de documentos). Cerrar la sesión no lo crea: sin esto, un cliente antiguo no vería
 * nunca lo que solo editó el LLM, porque el fichero binario (`files.sha256`) solo cambia con un
 * punto de control. Pero cada punto es un blob completo nuevo (y el MCP no borra blobs hasta
 * `B-N21`), así que no se crea con cada lote: solo si el último tiene 30 minutos o más
 * (`autoCheckpointDue`, `CHECKPOINT_INTERVAL_MS`).
 *
 * `checkpointAfterBatch` es lo que llama la herramienta de edición DESPUÉS de aplicar el lote.
 * Nunca lanza: lo ya aplicado no se rompe por un punto de control que falle. Devuelve un
 * resultado tipado (`CheckpointOutcome`) y, si no pudo escribir, no escribe nada.
 *
 * Orden y turnos:
 * 1. Fuera del turno de escritura: se lee la cabecera, se mira si toca y se EXPORTA (el exportador
 *    puede tardar y no debe bloquear la cola del almacén).
 * 2. Se compara la huella del documento (cabecera y updates pendientes) antes y después de
 *    exportar. Si cambió, los bytes exportados ya no son el estado actual: `stale`, sin escribir.
 *    El lote siguiente lo intentará otra vez.
 * 3. El blob se escribe en un turno propio (`writeExclusive`) que, antes de guardarlo, aplica la
 *    guarda de privacidad (`guardDocumentWrite`, regla (b) de D10 sobre el hash): si una nota
 *    oculta enlaza esos bytes, o el documento ya no es visible, `hidden` y no se escribe nada.
 * 4. El resto (retención, `docSetHead`, `fileReplace`, aviso al canal) es `takeCheckpoint` de
 *    Hebra, con su orden de B-D10 (R15).
 *
 * Qué pasa si el documento cambia DESPUÉS del paso 2 (entre la comparación y la escritura): el
 * punto de control es una instantánea un poco anterior, como ya admite Hebra (`files.sha256`
 * puede no ser la última edición). Los updates siguen en el almacén y el siguiente punto de
 * control los recoge. No se pierde nada.
 *
 * El exportador se pasa como dependencia: el registro de `setDocumentExporter`
 * (`./document-channel.ts`) es privado de ese módulo. Quien cablee la herramienta pasa aquí el
 * mismo exportador que registre.
 */
import { createHash } from 'node:crypto';
import type {
  DocHeadRecord,
  DocFormat,
  DocStoreHeadIfGenerationPort,
  DocStorePort
} from '../../vendor/hebra/src/lib/documents/contract';
import {
  autoCheckpointDue,
  takeCheckpoint,
  type CheckpointDeps
} from '../../vendor/hebra/src/lib/documents/sync/checkpoint';
import { createDocSerial } from '../../vendor/hebra/src/lib/documents/sync/document-store';
import type { DocSerial } from '../../vendor/hebra/src/lib/documents/sync/generation-flow';
import type { PrivacyConfig } from '../privacy/config';
import type { DocumentChannelSource, DocumentExporter } from './document-channel';
import { guardDocumentWrite } from './document-privacy';
import type { NoteWriteStore } from './writes';

/** Lo que `checkpointAfterBatch` necesita de quien lo llama. */
export interface CheckpointAfterBatchDeps {
  /** El canal de documentos del contexto (`NodeLibraryPort.documentSource()`), ya cableado. */
  source: DocumentChannelSource;
  /** Un turno de escritura del almacén (`NodeLibraryPort.writeExclusive`). */
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
  /** Los privados de quien pide, para la regla (b). */
  privacy: PrivacyConfig;
  /** El exportador de formatos; `null` si no hay ninguno registrado. */
  exportDocument: DocumentExporter | null;
  /** Reloj; por defecto `Date.now`. */
  now?: () => number;
}

/** Qué pasó. Solo `created` escribe algo. */
export type CheckpointOutcome =
  | { status: 'created'; sha256: string }
  /** El último punto de control tiene menos de 30 minutos. */
  | { status: 'not-due' }
  /** El estado exportado es el que ya hay en `files`: nada que escribir. */
  | { status: 'unchanged'; sha256: string }
  /** No se pudo ni intentar: sin exportador o sin canal montado. Queda para el lote siguiente. */
  | { status: 'pending'; reason: 'exporter-unavailable' | 'channel-not-wired' }
  /** El documento cambió mientras se exportaba: los bytes ya no son el estado actual. */
  | { status: 'stale' }
  /** Regla (b) o documento no visible: `not_found`, sin escribir. */
  | { status: 'hidden' }
  /** Falló la exportación o la escritura; `message` es el código del error. */
  | { status: 'failed'; message: string };

const MIME: Record<DocFormat, string> = {
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation'
};

/** Una operación a la vez por documento y canal, como las del cableado de Hebra. */
const serials = new WeakMap<DocumentChannelSource, DocSerial>();
function serialOf(source: DocumentChannelSource): DocSerial {
  let serial = serials.get(source);
  if (!serial) {
    serial = createDocSerial();
    serials.set(source, serial);
  }
  return serial;
}

/** Lo que cambia si alguien escribe en el documento: cabecera y updates pendientes. */
function fingerprint(read: {
  head: DocHeadRecord | null;
  segments: Uint8Array[];
  pendingSeqs: number[];
}): string {
  const { head } = read;
  return JSON.stringify([
    head?.generation ?? null,
    head?.checkpointSha256 ?? null,
    head?.segments ?? null,
    head?.recent ?? null,
    read.segments.length,
    read.pendingSeqs
  ]);
}

/** Marca de una exportación que quedó vieja; no sale de este módulo. */
class StaleExport extends Error {}
/** Marca de una escritura rechazada por privacidad; no sale de este módulo. */
class HiddenCheckpoint extends Error {}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * El almacén del cableado (`wiring.store`) se declara como `DocStorePort`, pero es el puerto del
 * canal con la guarda de purga de Hebra, que conserva `docSetHeadIfGeneration` si el puerto lo
 * tiene (`documentPortOf` lo da). `takeCheckpoint` lo exige: sin él no se escribe nada.
 */
function storeWithHeadIfGeneration(
  store: DocStorePort
): (DocStorePort & DocStoreHeadIfGenerationPort) | null {
  const candidate = store as DocStorePort & Partial<DocStoreHeadIfGenerationPort>;
  return typeof candidate.docSetHeadIfGeneration === 'function'
    ? (candidate as DocStorePort & DocStoreHeadIfGenerationPort)
    : null;
}

/**
 * Tras un lote del LLM sobre `fileId`: crea un punto de control si el último tiene 30 minutos o
 * más. No lanza nunca.
 */
export async function checkpointAfterBatch(
  deps: CheckpointAfterBatchDeps,
  fileId: string
): Promise<CheckpointOutcome> {
  const { source } = deps;
  const wiring = source.wiring;
  if (!wiring) return { status: 'pending', reason: 'channel-not-wired' };
  const store = storeWithHeadIfGeneration(wiring.store);
  if (!store) return { status: 'failed', message: 'doc_store_without_head_if_generation' };
  const now = deps.now ?? (() => Date.now());

  try {
    return await serialOf(source)(fileId, async (): Promise<CheckpointOutcome> => {
      const before = await source.port.docRead(fileId);
      if (!before.head) return { status: 'failed', message: 'doc_head_missing' };
      if (!autoCheckpointDue(before.head, now())) return { status: 'not-due' };
      const exportDocument = deps.exportDocument;
      if (!exportDocument) return { status: 'pending', reason: 'exporter-unavailable' };

      const format = before.head.format;
      const reference = fingerprint(before);

      const checkpointDeps: CheckpointDeps = {
        store,
        retention: wiring.retention,
        notifyLocalChange: (id) => wiring.channel.notifyLocalChange(id),
        now,
        // `fileRead` y `fileReplace` son los del puerto del canal (D2: ninguna otra fuente los
        // llama). Solo el blob se escribe aquí, en un turno que antes aplica la regla (b).
        library: {
          ...source.port,
          blobPut: (bytes, options) =>
            deps.writeExclusive(async (store) => {
              const sha256 = createHash('sha256').update(bytes).digest('hex');
              try {
                guardDocumentWrite({ store, privacy: deps.privacy }, fileId, sha256);
              } catch (error) {
                if (messageOf(error) === 'not_found') throw new HiddenCheckpoint('not_found');
                throw error;
              }
              return store.blobPut(bytes, { ...options, mime: MIME[format], expectedSha256: sha256 });
            })
        },
        exportDocument: async (id, head) => {
          const exported = await exportDocument({ libraryId: source.libraryId, store: wiring.store }, id, head);
          const after = await source.port.docRead(id);
          if (fingerprint(after) !== reference) throw new StaleExport('stale');
          return exported;
        }
      };

      const sha256 = await takeCheckpoint(checkpointDeps, fileId, 'auto');
      // Sin cambios (o con un `/h` que ya lo llevaba) la cabecera no se toca.
      const head = (await source.port.docRead(fileId)).head;
      if (head && head.checkpointSha256 === before.head.checkpointSha256) return { status: 'unchanged', sha256 };
      return { status: 'created', sha256 };
    });
  } catch (error) {
    if (error instanceof StaleExport) return { status: 'stale' };
    if (error instanceof HiddenCheckpoint) return { status: 'hidden' };
    const message = messageOf(error);
    if (message === 'document-export-unavailable') return { status: 'pending', reason: 'exporter-unavailable' };
    return { status: 'failed', message };
  }
}
