/**
 * `SyncStorePort`: la vista del almacén que ve el motor de sync de Hebra
 * (`LibrarySyncEngine`, `library/sync-engine`), y SOLO él. Es el `LibraryPort` de
 * Hebra (`library/types`, «el puerto estrecho de §6.1») tal cual: `sync*`,
 * `library*Binding`, `libraryConnect`, `blobPut`/`blobRead` y las cinco operaciones de
 * nota que ese interfaz exige. Delega en el MISMO `SqliteLibraryEngine` y la MISMA cola
 * (`SerialQueue`) que `NodeLibraryPort`, igual que `LocalLibraryPort` de Hebra lo hace
 * para el worker web (sus métodos `sync*` son un `enqueue` directo al motor; aquí,
 * idem).
 *
 * Por qué es otra vista y no métodos de `NodeLibraryPort`: `HebraLibraryPort` es lo que
 * ve la capa de herramientas, y D2 (SPEC.md §3/§5) le prohíbe cualquier mutación fuera
 * de crear y añadir. `syncApplyPage`/`syncAck`/`libraryConnect` son mutaciones que solo
 * tienen sentido dentro de una ronda de sync; nadie más debe poder llamarlas. Ninguno
 * de los dos interfaces trae `noteMove`/`noteTrash`/`notePurge`/`folder*`/`file*`/
 * `tagRename` (`test/store/surface.node.test.ts`). Los dos `file*` que D10 (9 oct 2026)
 * permite, mandar un fichero suelto a la papelera y sacarlo, tampoco están aquí: solo en
 * el turno de escritura (`NodeLibraryPort.writeExclusive`). Lo que esta vista sí hace con
 * los ficheros sueltos es lo de cualquier registro: la ronda sube y baja sus filas.
 *
 * `syncLeaseAcquire` es el de `SqliteLibraryEngine` (en memoria del proceso): coordina
 * motores dentro de este proceso, no entre procesos. Entre procesos manda el bloqueo de
 * `src/lock/` (SPEC.md §8).
 */
import type { LibraryPort, SqliteLibraryEngine } from '../hebra';
import { busyOtherInstance } from './errors';
import type { SerialQueue } from './serial-queue';

/** El `LibraryPort` de Hebra, con el nombre que tiene en hebra-mcp. */
export type SyncStorePort = LibraryPort;

/**
 * Construye la vista de sync sobre `engine`. Con `writable: false` (instancia que no es
 * el escritor único) las lecturas funcionan y cualquier mutación rechaza con
 * `busy_other_instance` sin tocar el motor: el `SyncRunner` nunca corre en esa
 * instancia, pero si algo lo intentara, no llegaría a SQLite.
 */
export function createSyncStorePort(
  engine: SqliteLibraryEngine,
  queue: SerialQueue,
  writable: () => boolean
): SyncStorePort {
  const read = <T>(operation: () => T | Promise<T>): Promise<T> => queue.run(operation);
  const write = <T>(operation: () => T | Promise<T>): Promise<T> =>
    writable() ? queue.run(operation) : Promise.reject(busyOtherInstance());

  return {
    libraryOpen: () => read(() => engine.libraryOpen()),
    noteCreate: (folderId) => write(() => engine.noteCreate(folderId ?? null)),
    noteRead: (id) => read(() => engine.noteRead(id)),
    noteSave: (input) => write(() => engine.noteSave(input)),
    notesPage: (cursor, limit) => read(() => engine.notesPage(cursor, limit)),
    syncDirtyBatch: (limit) => read(() => engine.syncDirtyBatch(limit)),
    syncMarkPending: (entries) => write(() => engine.syncMarkPending(entries)),
    syncApplyPage: (records) => write(() => engine.syncApplyPage(records)),
    syncAck: (entries) => write(() => engine.syncAck(entries)),
    syncSinceSeq: () => read(() => engine.sinceSeq()),
    libraryGetBinding: () => read(() => engine.getBinding()),
    librarySetBinding: (binding) => write(() => engine.setBinding(binding)),
    libraryConnect: (input) => write(() => engine.libraryConnect(input)),
    syncStatus: () => read(() => engine.syncStatus()),
    syncBlobsPending: (limit) => read(() => engine.syncBlobsPending(limit)),
    syncBlobsMarkUploaded: (sha256s) => write(() => engine.syncBlobsMarkUploaded(sha256s)),
    syncBlobsMarkTooLarge: (sha256s) => write(() => engine.syncBlobsMarkTooLarge(sha256s)),
    // En memoria del motor: no escribe en la base, pero solo el escritor sincroniza.
    syncLeaseAcquire: (ownerId, ttlMs) =>
      writable() ? read(() => engine.syncLeaseAcquire(ownerId, ttlMs)) : Promise.resolve(false),
    blobPut: (bytes, options) => write(() => engine.blobPut(bytes, options)),
    blobRead: (sha256) => read(() => engine.blobRead(sha256)),
    // No es una de las cinco mutaciones de nota ni un `sync*`: es el `libraryReset` del
    // `LibraryPort` de Hebra («Descargar la biblioteca del servidor», §6.6), que TS exige
    // aquí desde `20889178`. Nadie en hebra-mcp lo llama todavía (no hay herramienta MCP
    // ni botón de ajustes que lo dispare): existe solo para que `SyncStorePort` siga
    // implementando el interfaz completo. D2 no lo prohíbe (`FORBIDDEN_NAME` de
    // `test/store/surface.node.test.ts` no incluye `libraryReset`).
    libraryReset: () => write(() => engine.libraryReset())
  };
}
