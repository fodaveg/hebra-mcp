/**
 * H-BLOQUEO-SYNC: la limpieza de blobs sustituidos (B-N21) en su turno REAL de `NodeLibraryPort`,
 * con SQLite en fichero y `FsBlobStore` en disco. Lo único de mentira es el cableado de sync
 * (`source.wiring`): la retención sin nada retenido (el `/h` ya confirmado) y ningún exportador,
 * así que el punto de control queda en `pending` y solo corre la limpieza.
 *
 * El fallo que cubre: `checkpointThenClean` abría un turno de escritura y, dentro,
 * `removeSupersededBlobs` leía la cabecera (`docRead`) y los pines de los demás documentos
 * (`otherPins`) por la cola del puerto, que ese turno ya ocupa. La edición de hojas no volvía
 * nunca con un escritor vinculado al sync. Aquí se detecta sin tiempos: mientras corre el turno,
 * entrar en la cola (`read` o `write` del puerto) lanza `QueueEnteredInTurn` en el acto, y la
 * limpieza (que no lanza nunca) no borra nada.
 *
 * Y la condición de B-N21 que el arreglo no puede romper: leer y borrar en el MISMO turno. Un pin
 * de otro documento que entra en la cola justo antes del turno de la limpieza (después de
 * cualquier lectura que se hiciera fuera de él) tiene que verse: el blob no se borra.
 *
 * Pruebas negativas hechas al escribirlo (se rompe, el test cae, se restaura):
 * - el código de antes (lecturas por `source.port` dentro del turno): cae «borra el sustituido sin
 *   entrar en la cola» con `removed: 0`;
 * - leer cabecera y pines FUERA del turno, por la cola, y pasarlos dentro: cae «un pin que entra
 *   antes del turno».
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocHeadRecord } from '../../vendor/hebra/src/lib/documents/contract';
import { newDocumentHead } from '../../vendor/hebra/src/lib/documents/sync/lifecycle';
import type { PrivacyConfig } from '../../src/privacy/config';
import { FsBlobStore } from '../../src/store/blob-store-fs';
import { checkpointThenClean, FsSupersededJournal } from '../../src/store/document-blob-cleanup';
import type { DocumentChannelSource } from '../../src/store/document-channel';
import { openNodeLibraryPort, type NodeLibraryPort } from '../../src/store/node-port';
import type { NoteWriteStore } from '../../src/store/writes';

const CONFIG: PrivacyConfig = { privateFolders: [], privateTags: [] };
const ports: NodeLibraryPort[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const port of ports.splice(0)) await port.closeWhenIdle();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Entrar en la cola con un turno abierto: el interbloqueo, detectado sin esperar. */
class QueueEnteredInTurn extends Error {
  constructor() {
    super('queue-entered-in-turn');
  }
}

interface World {
  directory: string;
  port: NodeLibraryPort;
  source: DocumentChannelSource;
  blobs: FsBlobStore;
  fileId: string;
  otherId: string;
  /** El blob sustituido, en disco y anotado en el diario como pendiente. */
  superseded: string;
  /** Hay un turno de escritura en curso (lo abre `writeExclusive` de abajo). */
  inTurn: boolean;
  /** Se llama justo antes de pedir cada turno, fuera de él. */
  beforeTurn: (() => void) | null;
  writeExclusive<T>(operation: (store: NoteWriteStore) => Promise<T>): Promise<T>;
}

async function world(): Promise<World> {
  const directory = mkdtempSync(join(tmpdir(), 'hebra-mcp-cleanup-turn-'));
  directories.push(directory);
  const port = await openNodeLibraryPort({ sqlitePath: join(directory, 'library.sqlite'), dataDir: directory });
  ports.push(port);
  const [base, checkpoint, old] = ['base', 'punto', 'sustituido'].map((text) => encoder.encode(text));
  const ids = await port.writeExclusive(async (store) => {
    const folder = (await store.folderCreate('root', 'Hojas')).id;
    for (const bytes of [base!, checkpoint!, old!]) await store.blobPut(bytes, { expectedSha256: sha(bytes) });
    const file = (await store.fileCreate(folder, 'hoja.ods', sha(checkpoint!))).id;
    const other = (await store.fileCreate(folder, 'otra.ods', sha(base!))).id;
    return { file, other };
  });
  const source = port.documentSource();
  // Cabecera con punto de control: lo fijado es la base y el punto; el sustituido ya no.
  const head: DocHeadRecord = { ...newDocumentHead('ods', 'g1', sha(base!)), checkpointSha256: sha(checkpoint!) };
  await source.port.docSetHead(ids.file, head, [sha(base!), sha(checkpoint!)]);
  await new FsSupersededJournal(directory).save(ids.file, {
    pins: [sha(base!), sha(checkpoint!)],
    pending: [sha(old!)]
  });
  // El cableado justo para la limpieza: nada retenido (el `/h` está confirmado).
  source.wiring = {
    store: source.port,
    retention: { isHeld: () => false, holdFiles: async () => undefined, releaseFiles: async () => undefined },
    channel: { notifyLocalChange: () => undefined }
  } as unknown as DocumentChannelSource['wiring'];

  const w: World = {
    directory,
    port,
    source,
    blobs: new FsBlobStore(directory),
    fileId: ids.file,
    otherId: ids.other,
    superseded: sha(old!),
    inTurn: false,
    beforeTurn: null,
    writeExclusive: (operation) => {
      w.beforeTurn?.();
      return port.writeExclusive(async (store) => {
        w.inTurn = true;
        try {
          return await operation(store);
        } finally {
          w.inTurn = false;
        }
      });
    }
  };
  // Dentro de un turno, entrar en la cola del puerto lanza en el acto.
  const queue = port as unknown as Record<'read' | 'write', (operation: () => unknown) => Promise<unknown>>;
  for (const method of ['read', 'write'] as const) {
    const real = queue[method].bind(port);
    vi.spyOn(queue, method).mockImplementation((operation) => {
      if (w.inTurn) throw new QueueEnteredInTurn();
      return real(operation);
    });
  }
  return w;
}

function clean(w: World) {
  return checkpointThenClean(
    {
      checkpoint: { source: w.source, writeExclusive: (op) => w.writeExclusive(op), privacy: CONFIG, exportDocument: null },
      cleanup: { blobs: w.blobs, journal: new FsSupersededJournal(w.directory) }
    },
    w.fileId
  );
}

describe('limpieza de blobs en el turno real (H-BLOQUEO-SYNC, B-N21)', () => {
  it('borra el sustituido sin entrar en la cola desde su propio turno', async () => {
    const w = await world();
    expect(await w.blobs.read(w.superseded)).not.toBeNull();
    const { outcome, cleanup } = await clean(w);
    expect(outcome).toEqual({ status: 'pending', reason: 'exporter-unavailable' });
    expect(cleanup).toEqual({ removed: 1, kept: 0 });
    expect(await w.blobs.read(w.superseded)).toBeNull();
  });

  it('un pin de otro documento que entra en la cola antes del turno de la limpieza conserva el blob', async () => {
    const w = await world();
    const pinned: DocHeadRecord = { ...newDocumentHead('ods', 'g2', w.superseded), checkpointSha256: null };
    let pin: Promise<void> | null = null;
    let turns = 0;
    w.beforeTurn = () => {
      // El único turno de esta pasada es el de la limpieza: el pin entra justo antes que él.
      turns += 1;
      pin ??= w.source.port.docSetHead(w.otherId, pinned, [w.superseded]);
    };
    const { cleanup } = await clean(w);
    await pin;
    expect(turns).toBe(1);
    expect(cleanup).toEqual({ removed: 0, kept: 0 });
    expect(await w.blobs.read(w.superseded)).not.toBeNull();
  });
});
