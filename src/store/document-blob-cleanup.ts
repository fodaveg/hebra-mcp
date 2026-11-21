/**
 * Limpieza de los blobs que un punto de control deja sustituidos (paquete B-N21, decisión 15 y
 * R29). Cada punto de control (`./document-checkpoint.ts`) es un blob completo nuevo y el MCP no
 * borraba ninguno: el disco crecía sin tope.
 *
 * Qué se borra. Un blob es CANDIDATO si figuró en los hashes fijados del `/h` (`defaultDocPins`:
 * base, punto de control y versiones) y el `/h` actual ya no lo cita. Pasa cuando un punto de
 * control sin confirmar se sustituye por otro (R6) o cuando una versión sale por el tope. Un
 * candidato se borra solo si, EN EL MISMO TURNO de escritura, ninguna de estas cosas lo retiene:
 * 1. El `/h` actual no lo fija, ni la retención lo tiene en espera de su acuse.
 * 2. El `/h` actual está CONFIRMADO: su hash de punto de control ya no está retenido
 *    (`isHeld`), que es el acuse del relé (`doc-channel.ts` suelta la retención con él). Antes
 *    del acuse no se borra nada: otro dispositivo aún puede necesitar el `/h` anterior, y
 *    borrar antes pierde una versión retenida (rotura de R29).
 * 3. Ningún `files.sha256` (vivo o en la papelera) lo usa.
 * 4. Ninguna nota (viva o en la papelera) lo enlaza.
 * 5. Ningún otro documento lo fija (`otherPins`): el mismo contenido puede ser versión de dos
 *    documentos, también de otro espacio.
 *
 * Mejor esfuerzo y duradero. Un fallo al borrar o al leer no rompe nada ni se propaga: el
 * candidato se queda en un diario en disco (`<raíz>/superseded/`) y se reintenta en la pasada
 * siguiente. Como el diario se escribe antes de borrar, un corte entre el acuse y el borrado no
 * pierde candidatos; borrar un fichero que ya no está no es un error.
 *
 * Sin cablear (queda para quien monte la herramienta de edición, B-I01): llamar a
 * `checkpointThenClean` en lugar de `checkpointAfterBatch`, con `otherPins` real (la tabla
 * `doc_pins` de todos los documentos) y el `FsBlobStore` del contexto. No hace falta tocar
 * `node-port.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocHeadRecord } from '../../vendor/hebra/src/lib/documents/contract';
import { defaultDocPins } from '../../vendor/hebra/src/lib/documents/sync/doc-channel';
import { isSha256Hex } from './blob-store-fs';
import {
  checkpointAfterBatch,
  type CheckpointAfterBatchDeps,
  type CheckpointOutcome
} from './document-checkpoint';
import type { WriteTurn } from './document-create';

/** Lo único que la limpieza pide al almacén de bytes: `FsBlobStore` lo cumple. */
export interface RemovableBlobStore {
  remove(sha256: string): Promise<void>;
}

/** Lo que el diario guarda de un documento. */
export interface SupersededState {
  /** Los hashes que fijaba su `/h` la última vez que se miró. */
  pins: string[];
  /** Candidatos a borrar que aún no se han borrado. */
  pending: string[];
}

/** Diario duradero de candidatos, uno por documento. */
export interface SupersededJournal {
  load(fileId: string): Promise<SupersededState>;
  save(fileId: string, state: SupersededState): Promise<void>;
}

/** Diario en disco: `<raíz>/superseded/<sha256 del id>.json`, escritura atómica. */
export class FsSupersededJournal implements SupersededJournal {
  constructor(private readonly root: string) {}

  /** El id del fichero es un hash: un id raro nunca decide una ruta. */
  private pathOf(fileId: string): string {
    return join(this.root, 'superseded', `${createHash('sha256').update(fileId).digest('hex')}.json`);
  }

  async load(fileId: string): Promise<SupersededState> {
    try {
      const raw = JSON.parse(await readFile(this.pathOf(fileId), 'utf8')) as Partial<SupersededState>;
      return { pins: cleanShas(raw.pins), pending: cleanShas(raw.pending) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { pins: [], pending: [] };
      // Diario ilegible: se empieza de cero. Solo se pierde la memoria de candidatos, no datos.
      if (error instanceof SyntaxError) return { pins: [], pending: [] };
      throw error;
    }
  }

  async save(fileId: string, state: SupersededState): Promise<void> {
    const finalPath = this.pathOf(fileId);
    await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
    const tmpPath = `${finalPath}.tmp`;
    const handle = await open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, finalPath);
  }
}

/** Lo que una pasada necesita además del turno. */
export interface CleanupDeps {
  blobs: RemovableBlobStore;
  journal: SupersededJournal;
  /** La cabecera actual del documento (`DocumentPort.docRead`). */
  docRead(fileId: string): Promise<{ head: DocHeadRecord | null }>;
  /** La retención del `/h` sin acuse (`wiring.retention.isHeld`). */
  isHeld(fileId: string, sha256: string): boolean;
  /** Hashes que fijan los `/h` de los DEMÁS documentos, de cualquier espacio. */
  otherPins(fileId: string): Promise<ReadonlySet<string>> | ReadonlySet<string>;
}

export interface CleanupResult {
  removed: number;
  /** Candidatos que siguen en pie (sin acuse, retenidos o por reintentar). */
  kept: number;
}

/** Solo los hashes bien formados, en minúscula y sin repetir: vienen de datos sincronizados. */
function cleanShas(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => (typeof value === 'string' ? value.toLowerCase() : value)))].filter(
    isSha256Hex
  );
}

/**
 * Una pasada para `fileId`, dentro del turno de escritura. No lanza nunca: ante cualquier fallo
 * deja el diario como estaba y devuelve lo que quedó. Primero anota como candidatos los hashes
 * que el `/h` fijaba y ya no fija; después borra los que cumplen todas las condiciones de la
 * cabecera de este fichero.
 */
export async function removeSupersededBlobs(
  turn: WriteTurn,
  fileId: string,
  deps: CleanupDeps
): Promise<CleanupResult> {
  try {
    const { head } = await deps.docRead(fileId);
    if (!head) return { removed: 0, kept: 0 };
    const state = await deps.journal.load(fileId);
    const pinned = new Set(cleanShas(defaultDocPins(head)));
    // Lo que fijaba y ya no fija, más lo que quedó pendiente de una pasada anterior.
    const candidates = new Set([...state.pending, ...state.pins.filter((sha) => !pinned.has(sha))]);
    const acknowledged = head.checkpointSha256 !== null && !deps.isHeld(fileId, head.checkpointSha256);

    let removed = 0;
    const remaining = new Set<string>();
    if (!acknowledged) {
      // Sin acuse del `/h` nuevo no se borra nada: se anotan y se espera.
      for (const sha of candidates) if (!pinned.has(sha)) remaining.add(sha);
    } else {
      const live = liveReferences(turn, [...candidates].filter((sha) => !pinned.has(sha)));
      const others = new Set(await deps.otherPins(fileId));
      for (const sha of candidates) {
        // Fijado por este `/h`, usado por un fichero o una nota viva, o fijado por otro
        // documento: ya no es un sustituido. Sale del diario; si luego queda libre, quien lo
        // suelte lo vuelve a anotar o lo recoge el GC del motor.
        if (pinned.has(sha) || live.has(sha) || others.has(sha)) continue;
        if (deps.isHeld(fileId, sha)) {
          remaining.add(sha);
          continue;
        }
        try {
          await deps.blobs.remove(sha);
          removed += 1;
        } catch {
          remaining.add(sha);
        }
      }
    }
    try {
      await deps.journal.save(fileId, { pins: [...pinned], pending: [...remaining] });
    } catch {
      // Sin diario se pierde la anotación, no datos: los candidatos se recalculan.
    }
    return { removed, kept: remaining.size };
  } catch {
    return { removed: 0, kept: 0 };
  }
}

/** De `shas`, los que un fichero (también en la papelera) o una nota enlazan hoy. */
function liveReferences(turn: WriteTurn, shas: readonly string[]): Set<string> {
  const live = new Set<string>();
  if (shas.length === 0) return live;
  const { store } = turn;
  for (const file of store.filesIndex().files) live.add(file.sha256.toLowerCase());
  const used = new Set<string>();
  for (const sha of shas) {
    if (live.has(sha) || store.notesLinkingBlob(sha).length > 0) used.add(sha);
  }
  return used;
}

/** Lo que `checkpointThenClean` pide: lo del punto de control más lo de la limpieza. */
export interface CheckpointThenCleanDeps {
  checkpoint: CheckpointAfterBatchDeps;
  cleanup: Omit<CleanupDeps, 'docRead' | 'isHeld'>;
}

/**
 * `checkpointAfterBatch` y, después, una pasada de limpieza en un turno de escritura. Antes del
 * punto de control anota los hashes que fija el `/h`, para que la primera sustitución también se
 * detecte. La limpieza corre también con `not-due` o `failed`: así se reintenta lo que quedó a
 * medias. No lanza nunca.
 */
export async function checkpointThenClean(
  deps: CheckpointThenCleanDeps,
  fileId: string
): Promise<{ outcome: CheckpointOutcome; cleanup: CleanupResult }> {
  const wiring = deps.checkpoint.source.wiring;
  const none: CleanupResult = { removed: 0, kept: 0 };
  const read = (id: string) => deps.checkpoint.source.port.docRead(id);
  const cleanupDeps: CleanupDeps | null = wiring
    ? { ...deps.cleanup, docRead: read, isHeld: (id, sha) => wiring.retention.isHeld(id, sha) }
    : null;
  if (cleanupDeps) await seedPins(cleanupDeps, fileId);
  const outcome = await checkpointAfterBatch(deps.checkpoint, fileId);
  if (!cleanupDeps) return { outcome, cleanup: none };
  try {
    const cleanup = await deps.checkpoint.writeExclusive((store) =>
      removeSupersededBlobs({ store, privacy: deps.checkpoint.privacy }, fileId, cleanupDeps)
    );
    return { outcome, cleanup };
  } catch {
    return { outcome, cleanup: none };
  }
}

/** Anota los hashes fijados si el diario no sabe aún de este documento. No lanza. */
async function seedPins(deps: CleanupDeps, fileId: string): Promise<void> {
  try {
    const state = await deps.journal.load(fileId);
    if (state.pins.length > 0) return;
    const { head } = await deps.docRead(fileId);
    if (head) await deps.journal.save(fileId, { pins: cleanShas(defaultDocPins(head)), pending: state.pending });
  } catch {
    // Sin diario no hay limpieza de esa sustitución; nada más se rompe.
  }
}
