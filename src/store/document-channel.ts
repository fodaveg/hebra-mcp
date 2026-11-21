/**
 * Canal de documentos con cabecera (`.ods`, `.odp`) del MCP (paquete B-D15): lo que une el
 * almacén de un contexto (la biblioteca personal o un espacio) con el cableado de sync de
 * Hebra (`createDocumentSyncWiring`, `vendor/hebra/src/lib/documents/sync/wiring.ts`). Aquí no
 * hay lógica de sync: solo el puerto del almacén, el `Storage` duradero del vínculo y el
 * registro de las sesiones abiertas.
 *
 * Quién usa qué:
 * - `NodeLibraryPort` crea una `DocumentChannelSource` por contexto (`documentSource()`) y la
 *   anota en la vista de sync (`attachDocumentSource`), que es lo único que ve el runner.
 * - `SyncRunner.create` la recoge (`documentSourceOf`), monta el cableado con `wireDocuments`
 *   (una vez por motor) y pasa al motor `reservedRecords`, `filesRetention` y
 *   `onAfterApplyPage`.
 * - Una sesión de documento (`createDocSession`) escribe por `wiring.sessionStore`, nunca por
 *   `source.port`: así toma el cerrojo de escritura y avisa al canal tras cada `docAppend`.
 *   `docAppendWith` va dentro del turno de la cola del almacén: el update y lo que escriba
 *   `inTx` en la misma conexión (el registro de operaciones) se confirman o se revierten juntos.
 *
 * D2 (SPEC.md §3): el MCP no purga. `filePurge` existe porque el ciclo de vida de Hebra lo
 * exige en su tipo, pero rechaza siempre. La purga que llega de otro dispositivo no lo
 * necesita: el registro llega ya en lápida y `fileRead` da `null`.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import type { SqliteConn, SqliteLibraryEngine } from '../hebra';
import type { BlobPutOptions, BlobPutResult, FileRow } from './writes';
import { syncDocClearExternal, syncDocExternalMarks } from '../../vendor/hebra/src/lib/library/sync-store';
import type { DocHeadRecord, DocStoreAtomicPort, DocStorePort } from '../../vendor/hebra/src/lib/documents/contract';
import type { ExportedDocument } from '../../vendor/hebra/src/lib/documents/sync/checkpoint';
import {
  createDocumentSyncWiring,
  type DocumentSyncPort,
  type DocumentSyncWiring,
  type DocumentWiringStorage
} from '../../vendor/hebra/src/lib/documents/sync/wiring';

/** El puerto del almacén que ve el cableado: el de sync de Hebra más lo atómico y los libros. */
export type DocumentPort = DocumentSyncPort &
  DocStoreAtomicPort & {
    docRetentionSet(fileId: string, sha256: string): Promise<void>;
    docRetentionClear(fileId: string): Promise<void>;
    docRetentionLoad(): Promise<{ fileId: string; sha256: string }[]>;
    docPurgeSave(entry: { fileId: string; recordIds: string[]; done: boolean }): Promise<void>;
    docPurgeLoad(): Promise<{ fileId: string; recordIds: string[]; done: boolean }[]>;
  };

/**
 * Las escrituras de ficheros y blobs que pide el cableado (puntos de control, generaciones,
 * copias de conflicto). Las pone `NodeLibraryPort`, con la revalidación de la cuenta dentro del
 * turno: D2 (`test/store/surface.node.test.ts`) deja las llamadas del motor a `file*` y
 * `blobPut` en `node-port.ts` y en pocas fuentes más, y esta no es una de ellas.
 */
export interface DocumentFileWrites {
  create(
    folderId: string | null,
    name: string,
    sha256: string,
    options?: { requireUniqueName?: boolean }
  ): Promise<FileRow>;
  replace(id: string, sha256: string, expectedSha256?: string | null): Promise<FileRow>;
  trash(id: string): Promise<FileRow>;
  restore(id: string): Promise<FileRow>;
  putBlob(bytes: Uint8Array, options?: BlobPutOptions): Promise<BlobPutResult>;
}

/** Lo que `NodeLibraryPort` presta al canal: sus turnos y su conexión, sin abrirlos a nadie más. */
export interface DocumentHost {
  /** `personal` o el id del espacio: estable entre arranques. */
  libraryId: string;
  engine: SqliteLibraryEngine;
  db: DatabaseSync;
  conn: SqliteConn | undefined;
  read<T>(operation: () => T | Promise<T>): Promise<T>;
  write<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Revalida la cuenta y el espacio dentro del turno (`assertSpaceUserWrite`). */
  guard(): void;
  files: DocumentFileWrites;
}

/** Las filas de `files` que lee el cableado, con las columnas y la forma de `FileRow`. */
const FILE_COLUMNS = `fl.id, fl.folder_id, fl.name, fl.sha256, b.byte_length, b.mime, fl.created_at,
  fl.updated_at, fl.trashed_at, fl.conflict_of, fl.local_seq, fl.dirty`;

function fileRowOf(row: Record<string, unknown>): FileRow {
  const optional = (value: unknown) => (value === null || value === undefined ? null : value);
  return {
    id: String(row.id),
    folderId: String(row.folder_id),
    name: String(row.name),
    sha256: String(row.sha256),
    byteLength: Number(row.byte_length ?? 0),
    mime: optional(row.mime) === null ? null : String(row.mime),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    trashedAt: optional(row.trashed_at) === null ? null : Number(row.trashed_at),
    conflictOf: optional(row.conflict_of) === null ? null : String(row.conflict_of),
    localSeq: Number(row.local_seq),
    dirty: Number(row.dirty) !== 0
  };
}

/** Una sesión abierta de un documento: lo único que el canal necesita de ella. */
export interface OpenDocumentSession {
  close(): Promise<void>;
}

/** Las sesiones abiertas de un contexto, por documento. */
export class DocumentSessions {
  private readonly open = new Map<string, Set<OpenDocumentSession>>();

  /** Anota una sesión abierta. Devuelve la función que la retira (al cerrarla). */
  add(fileId: string, session: OpenDocumentSession): () => void {
    const set = this.open.get(fileId) ?? new Set<OpenDocumentSession>();
    set.add(session);
    this.open.set(fileId, set);
    return () => {
      set.delete(session);
      if (set.size === 0 && this.open.get(fileId) === set) this.open.delete(fileId);
    };
  }

  /** Los documentos con alguna sesión abierta (`openDocuments` del cableado). */
  openDocuments(): readonly string[] {
    return [...this.open.keys()];
  }

  /** Cierra las sesiones de un documento cuya generación cambió. Un fallo no corta a las demás. */
  async closeFor(fileId: string): Promise<void> {
    const sessions = [...(this.open.get(fileId) ?? [])];
    this.open.delete(fileId);
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }
}

/** Exporta el estado actual de un documento como fichero (lo aporta el registro de formatos). */
export type DocumentExporter = (
  context: { libraryId: string; store: DocStorePort },
  fileId: string,
  head: DocHeadRecord
) => Promise<ExportedDocument>;

let exporter: DocumentExporter = async () => {
  throw new Error('document-export-unavailable');
};

/**
 * Registra el exportador de formatos (`.ods`, `.odp`). Sin él, los puntos de control y las
 * generaciones fallan con `document-export-unavailable`, pero el canal sincroniza igual los
 * segmentos y arranca (el cableado tolera un documento que no se deja exportar).
 */
export function setDocumentExporter(next: DocumentExporter | null): void {
  exporter =
    next ??
    (async () => {
      throw new Error('document-export-unavailable');
    });
}

/** Todo lo de un contexto que hace falta para montar el canal. */
export interface DocumentChannelSource {
  readonly libraryId: string;
  readonly port: DocumentPort;
  readonly storage: DocumentWiringStorage;
  readonly sessions: DocumentSessions;
  externalMarks(): Promise<{ fileId: string; sha256: string }[]>;
  clearExternalMark(fileId: string): Promise<void>;
  /** El cableado montado por el runner de este contexto; `null` hasta entonces. */
  wiring: DocumentSyncWiring | null;
}

/** Un `Storage` síncrono sobre `meta`: la lectura es de caché y la escritura entra en la cola. */
function metaStorage(host: DocumentHost): DocumentWiringStorage {
  const cache = new Map<string, string | null>();
  return {
    getItem(key) {
      if (!cache.has(key)) {
        try {
          const row = host.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
            | { value: string }
            | undefined;
          cache.set(key, row ? row.value : null);
        } catch {
          return null;
        }
      }
      return cache.get(key) ?? null;
    },
    setItem(key, value) {
      cache.set(key, value);
      // Cuota, cierre o un lector: el vínculo vive solo en esta sesión, como sin `Storage`.
      void host
        .write(() => {
          host.db
            .prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
        })
        .catch(() => undefined);
    }
  };
}

/** Construye el puerto del almacén de documentos de un contexto, por la cola del puerto. */
function documentPortOf(host: DocumentHost): DocumentPort {
  const { engine } = host;
  /** Una escritura del usuario o de una sesión: revalida la cuenta dentro del turno. */
  const guarded = <T>(operation: () => T | Promise<T>): Promise<T> =>
    host.write(() => {
      host.guard();
      return operation();
    });
  return {
    docRead: (fileId) => host.read(() => engine.docRead(fileId)),
    docAppend: (fileId, generation, update) => guarded(() => engine.docAppend(fileId, generation, update)),
    docAppendWith: (fileId, generation, update, inTx) =>
      guarded(() => engine.docAppendWith(fileId, generation, update, inTx)),
    docCompact: (fileId, generation, part, state, throughSeq) =>
      guarded(() => engine.docCompact(fileId, generation, part, state, throughSeq)),
    docSetHead: (fileId, head, pinned) => guarded(() => engine.docSetHead(fileId, head, pinned)),
    // Lo que llega de la sync (una purga ajena, la retención, el libro) no es una escritura
    // del usuario: sin la revalidación, como el resto de lo que aplica una ronda.
    docDrop: (fileId) => host.write(() => engine.docDrop(fileId)),
    docRetentionSet: (fileId, sha256) => host.write(() => engine.docRetentionSet(fileId, sha256)),
    docRetentionClear: (fileId) => host.write(() => engine.docRetentionClear(fileId)),
    docRetentionLoad: () => host.read(() => engine.docRetentionLoad()),
    docPurgeSave: (entry) => host.write(() => engine.docPurgeSave(entry)),
    docPurgeLoad: () => host.read(() => engine.docPurgeLoad()),
    // SQL propio sobre `files`, como `filesIndex` (`./node-port.ts`): las listas del motor
    // están cerradas en todo `src` por D2. Solo vivos y fuera de la papelera, por id.
    filesList: (cursor, limit = 200) =>
      host.read(() => {
        const rows = host.db
          .prepare(
            `SELECT ${FILE_COLUMNS} FROM files fl LEFT JOIN blobs b ON b.sha256 = fl.sha256
             WHERE fl.deleted = 0 AND fl.trashed_at IS NULL AND fl.id > ? ORDER BY fl.id LIMIT ?`
          )
          .all(cursor ?? '', limit) as Record<string, unknown>[];
        const items = rows.map(fileRowOf);
        return { items, nextCursor: items.length === limit ? items[items.length - 1]!.id : null };
      }),
    fileRead: (ref) =>
      host.read(() => {
        const row = host.db
          .prepare(
            `SELECT ${FILE_COLUMNS} FROM files fl LEFT JOIN blobs b ON b.sha256 = fl.sha256
             WHERE fl.id = ? AND fl.deleted = 0 AND fl.trashed_at IS NULL`
          )
          .get(ref) as Record<string, unknown> | undefined;
        return row ? fileRowOf(row) : null;
      }),
    fileCreate: (folderId, name, sha256, options) => host.files.create(folderId, name, sha256, options),
    fileReplace: (id, sha256, expectedSha256) => host.files.replace(id, sha256, expectedSha256),
    fileTrash: (id) => host.files.trash(id),
    fileRestore: (id) => host.files.restore(id),
    // D2: el MCP no purga nunca. Solo está por el tipo del ciclo de vida.
    filePurge: () => Promise.reject(new Error('document-purge-not-allowed')),
    blobPut: (bytes, options) => host.files.putBlob(bytes, options),
    blobRead: (sha256) => host.read(() => engine.blobRead(sha256))
  };
}

/** Crea la fuente del canal de un contexto. La llama `NodeLibraryPort.documentSource()`. */
export function createDocumentSource(host: DocumentHost): DocumentChannelSource {
  const context = () => {
    if (!host.conn) throw new Error('document-channel-without-connection');
    return { db: host.conn, deviceLabel: 'Claude', now: () => Date.now() };
  };
  return {
    libraryId: host.libraryId,
    port: documentPortOf(host),
    storage: metaStorage(host),
    sessions: new DocumentSessions(),
    externalMarks: () => host.read(() => syncDocExternalMarks(context())),
    clearExternalMark: (fileId) => host.write(() => syncDocClearExternal(context(), fileId)),
    wiring: null
  };
}

/**
 * El puerto por el que escribe una sesión abierta (`createDocSession({ port })`): el
 * `sessionStore` del cableado, con el cerrojo de escritura y el aviso al canal tras cada
 * append, y con `docAppendWith` dentro del turno del almacén. Nunca `source.port`: ese no avisa
 * al canal y la edición no subiría hasta la ronda siguiente que se acordara de ella.
 */
export function sessionPortOf(source: DocumentChannelSource): DocStoreAtomicPort {
  const wiring = source.wiring;
  if (!wiring) throw new Error('document-channel-not-wired');
  const port = wiring.sessionStore as Partial<DocStoreAtomicPort>;
  if (typeof port.docAppendWith !== 'function') throw new Error('document-channel-without-atomic-append');
  return port as DocStoreAtomicPort;
}

/**
 * Engancha una sesión abierta al canal: queda anotada (`openDocuments`, para que un
 * reemplazo desde fuera la retome y una generación nueva la cierre) y recibe los updates V2 que
 * bajan del relé, que se aplican a su `Y.Doc`. Devuelve la función que la suelta; llámala al
 * cerrar la sesión.
 */
export function attachSession(
  source: DocumentChannelSource,
  session: OpenDocumentSession & { fileId: string; doc: Y.Doc }
): () => void {
  const wiring = source.wiring;
  if (!wiring) throw new Error('document-channel-not-wired');
  const forget = source.sessions.add(session.fileId, session);
  const unsubscribe = wiring.subscribe((fileId, update) => {
    if (fileId === session.fileId) Y.applyUpdateV2(session.doc, update, 'remote');
  });
  return () => {
    unsubscribe();
    forget();
  };
}

const sources = new WeakMap<object, DocumentChannelSource>();

/** Anota la fuente en la vista de sync del contexto: es el único objeto que recibe el runner. */
export function attachDocumentSource(view: object, source: DocumentChannelSource): void {
  sources.set(view, source);
}

/** La fuente del contexto de una vista de sync, o `undefined` (dobles de prueba, lectores). */
export function documentSourceOf(view: object): DocumentChannelSource | undefined {
  return sources.get(view);
}

/** Lo que el runner aporta al cableado: lo que solo existe cuando el motor ya está creado. */
export interface DocumentWireHooks {
  /** Una ronda de verdad y espera a que termine (`SyncRunner.requestRound`). */
  requestRound(): Promise<unknown>;
  /** Bytes de un blob, bajándolo del relé si hace falta (`LibrarySyncEngine.readBlob`). */
  readBlob(sha256: string): Promise<Uint8Array | null>;
}

/**
 * Monta el cableado de un contexto (una vez por motor) y lo deja en `source.wiring`. El
 * runner pasa al motor `reservedRecords`, `filesRetention` y `onAfterApplyPage` y llama a
 * `start()` antes de la primera ronda.
 */
export function wireDocuments(source: DocumentChannelSource, hooks: DocumentWireHooks): DocumentSyncWiring {
  const wiring = createDocumentSyncWiring({ libraryId: source.libraryId }, source.port, {
    exportDocument: (fileId, head) =>
      exporter({ libraryId: source.libraryId, store: wiring.store }, fileId, head),
    requestRound: () => hooks.requestRound(),
    readBlob: (sha256) => hooks.readBlob(sha256),
    externalMarks: () => source.externalMarks(),
    clearExternalMark: (fileId) => source.clearExternalMark(fileId),
    onGenerationChanged: (change) => void source.sessions.closeFor(change.fileId),
    openDocuments: () => source.sessions.openDocuments(),
    storage: source.storage
  });
  source.wiring = wiring;
  return wiring;
}
