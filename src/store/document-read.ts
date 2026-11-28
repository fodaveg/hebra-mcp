/**
 * Lectura del estado actual de un documento con cabecera (`.ods`, `.odp`) en el MCP (paquete
 * B-D16, riesgo R8). Un lector ve la última edición, también la que aún no está en `files`,
 * sin escribir nada.
 *
 * Por qué hay dos caminos:
 * - `openDocumentRead` PROYECTA: arma el `Y.Doc` con los segmentos y los updates pendientes del
 *   almacén (`docRead`) y deja que el formato lo proyecte. Es una lectura pura: no toma el
 *   cerrojo de escritura, no crea punto de control, no toca `files` ni el `/h`. Las herramientas
 *   de lectura del MCP (`hebra_doc_*`) pasan por aquí.
 * - `documentBytesForCopy` da los BYTES de fichero al día, y eso sí exige un punto de control
 *   (`ensureCheckpoint`): copiar `files.sha256` sin él daría la última versión guardada, no la
 *   última edición. Es lo que pide duplicar. Escribe (blob, `/h`, `files`), así que va aparte y
 *   nunca la llama una lectura.
 *
 * Privacidad (D28, protecciones 1 y 2). `openDocumentRead` no filtra: quien la llama comprueba
 * antes que el documento se ve (`visibleDocumentOf` de `./document-privacy.ts`).
 * `documentBytesForCopy` filtra siempre: antes de pedir el punto de control el documento tiene
 * que verse, y después de pedirlo, sus bytes no pueden ser los de algo oculto (regla (b) de D10).
 *
 * `ensureCheckpoint` exporta con el exportador de formatos que se registra con
 * `setDocumentExporter` (`./document-channel`); el de `.ods` lo registra el escritor en
 * `localWriteContext` (`../server/tools/sheet-export.ts`). Sin exportador, duplicar falla con
 * `DocumentExportUnavailableError` y no escribe nada.
 */
import * as Y from 'yjs';
import type { DocFormatAdapter, DocHeadRecord, DocStoreAtomicPort } from '../../vendor/hebra/src/lib/documents/contract';
import { createDocSession } from '../../vendor/hebra/src/lib/documents/session';
import type { PrivacyConfig } from '../privacy/config';
import type { DocumentChannelSource } from './document-channel';
import { projectionBaseSha256 } from './document-base';
import { guardDocumentRead, guardDocumentWrite } from './document-privacy';
import type { NoteWriteStore } from './writes';

/** Por qué una lectura no se pudo servir. El `message` es el código, como en `errors.ts`. */
export type DocumentReadCode =
  /** No hay cabecera de documento: no existe, o aún no ha llegado su `/h`. */
  | 'doc_head_missing'
  /** Falta el blob base o el punto de control y no se pudo bajar. */
  | 'blob_missing'
  /** El canal de este contexto no está montado (sin runner): no hay puntos de control. */
  | 'document_channel_unwired'
  /** Nadie ha registrado el exportador de formatos (`setDocumentExporter`). */
  | 'document_export_unavailable';

export class DocumentReadError extends Error {
  readonly code: DocumentReadCode;
  constructor(code: DocumentReadCode) {
    super(code);
    this.name = 'DocumentReadError';
    this.code = code;
  }
}

/** Duplicar pide un punto de control y falta el exportador real (`setDocumentExporter`). */
export class DocumentExportUnavailableError extends DocumentReadError {
  constructor() {
    super('document_export_unavailable');
    this.name = 'DocumentExportUnavailableError';
  }
}

/**
 * Lo único que lee la proyección: el puerto del almacén y sus blobs. Sin escrituras en el
 * documento. `readBlob` es opcional: en un dispositivo que aún no bajó la base, el runner la
 * baja del relé por la compuerta de descargas (`SyncRunner.readBlobBytes`). Es la única
 * escritura posible, y es caché de un blob que ya existe, no estado del documento.
 */
export type DocumentReadSource = Pick<DocumentChannelSource, 'port'> & {
  readBlob?(sha256: string): Promise<Uint8Array | null>;
};

/** Un documento abierto para leer: su estado de ahora, proyectado, y las dos revisiones. */
export interface DocumentRead<Model> {
  readonly fileId: string;
  readonly generation: string;
  readonly head: DocHeadRecord;
  /** El estado de ahora, como lo proyecta el formato. */
  readonly model: Model;
  /** La misma revisión que da la sesión de escritura sobre este estado (`expectedRevision`). */
  readonly revision: string;
  readonly layoutRevision: string;
  /** Updates del almacén aún sin compactar que entraron en la proyección. */
  readonly pending: number;
  /** El `Y.Doc` armado para esta lectura. Solo lectura por contrato: nadie lo persiste. */
  readonly doc: Y.Doc;
  /** Libera el `Y.Doc`. No escribe. */
  close(): Promise<void>;
}

/** El puerto de la sesión de lectura: cualquier intento de escribir por él es un fallo. */
const readOnlyPort: DocStoreAtomicPort = {
  docRead: () => Promise.reject(new Error('document_read_only')),
  docAppend: () => Promise.reject(new Error('document_read_only')),
  docAppendWith: () => Promise.reject(new Error('document_read_only')),
  docCompact: () => Promise.reject(new Error('document_read_only')),
  docSetHead: () => Promise.reject(new Error('document_read_only')),
  docDrop: () => Promise.reject(new Error('document_read_only'))
};

/**
 * Abre un documento para leerlo: segmentos y pendientes del almacén, proyección del formato.
 * No crea punto de control ni escribe. Lanza `DocumentReadError` si falta la cabecera o el blob.
 */
export async function openDocumentRead<Model, Op>(
  source: DocumentReadSource,
  fileId: string,
  adapter: DocFormatAdapter<Model, Op>,
  signal: AbortSignal = new AbortController().signal
): Promise<DocumentRead<Model>> {
  const stored = await source.port.docRead(fileId);
  const head = stored.head;
  if (!head) throw new DocumentReadError('doc_head_missing');
  // El fichero BASE de la generación, nunca el punto de control: el `Y.Doc` lleva ids relativos a
  // la base y el punto de control ya lo lleva dentro (`./document-base.ts`).
  const baseSha256 = projectionBaseSha256(head);
  const base = (await source.port.blobRead(baseSha256)) ?? (await source.readBlob?.(baseSha256)) ?? null;
  if (!base) throw new DocumentReadError('blob_missing');

  const doc = new Y.Doc();
  try {
    for (const piece of [...stored.segments, ...stored.pending]) Y.applyUpdateV2(doc, piece);
    // La sesión solo da las revisiones con la fórmula de la de escritura; por su puerto no se
    // puede escribir y aquí no se llama a `apply`.
    const session = createDocSession<Model, Op>({
      fileId,
      doc,
      generation: head.generation,
      adapter,
      port: readOnlyPort,
      base,
      signal
    });
    const model = await adapter.project(base, doc, signal);
    return {
      fileId,
      generation: head.generation,
      head,
      model,
      revision: session.revision(),
      layoutRevision: session.layoutRevision(),
      pending: stored.pending.length,
      doc,
      close: async () => {
        await session.close();
        doc.destroy();
      }
    };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** Con qué se filtra una copia: los turnos del almacén y los privados de quien la pide. */
export interface DocumentCopyAccess {
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
  privacy: PrivacyConfig;
}

/**
 * Los bytes de fichero al día de un documento, para duplicarlo o copiarlo (R8). Pide
 * `ensureCheckpoint` del canal: escribe un punto de control si hay ediciones sin exportar.
 * Sin exportador registrado lanza `DocumentExportUnavailableError` sin escribir nada.
 *
 * Un documento oculto da `not_found` antes de pedir nada. Si el punto de control sale con unos
 * bytes que enlaza una nota oculta, también `not_found`: esos bytes no se entregan.
 */
export async function documentBytesForCopy(
  source: Pick<DocumentChannelSource, 'port' | 'wiring'>,
  fileId: string,
  access: DocumentCopyAccess
): Promise<{ sha256: string; bytes: Uint8Array }> {
  const { privacy } = access;
  await access.writeExclusive(async (store) => guardDocumentRead({ store, privacy }, fileId));
  const wiring = source.wiring;
  if (!wiring) throw new DocumentReadError('document_channel_unwired');
  let sha256: string;
  try {
    sha256 = await wiring.checkpoints.ensureCheckpoint(fileId, 'close');
  } catch (error) {
    if (error instanceof Error && error.message === 'document-export-unavailable') {
      throw new DocumentExportUnavailableError();
    }
    throw error;
  }
  await access.writeExclusive(async (store) => guardDocumentWrite({ store, privacy }, fileId, sha256));
  const bytes = await source.port.blobRead(sha256);
  if (!bytes) throw new DocumentReadError('blob_missing');
  return { sha256, bytes };
}
